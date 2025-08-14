import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ConfigurationType } from '@server/configuration';
import { defaultCount, statusMap } from '@server/constants';
import { PrismaService } from '@server/prisma/prisma.service';
import { TRPCError, initTRPC } from '@trpc/server';
import Axios, { AxiosInstance } from 'axios';
import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone';
import utc from 'dayjs/plugin/utc';

dayjs.extend(utc);
dayjs.extend(timezone);

/**
 * tRPC procedure 的统一返回类型
 */
export type RefreshArticlesResult = {
  message: string;
  successCount: number;
  errorCount: number;
  failedFeeds: string[];
  hasHistory?: number;
  articlesCount: number;
};

/**
 * 读书账号每日小黑屋
 */
const blockedAccountsMap = new Map<string, string[]>();

@Injectable()
export class TrpcService {
  trpc = initTRPC.create();
  publicProcedure = this.trpc.procedure;
  protectedProcedure = this.trpc.procedure.use(({ ctx, next }) => {
    const errorMsg = (ctx as any).errorMsg;
    if (errorMsg) {
      throw new TRPCError({ code: 'UNAUTHORIZED', message: errorMsg });
    }
    return next({ ctx });
  });
  router = this.trpc.router;
  mergeRouters = this.trpc.mergeRouters;
  request: AxiosInstance;
  updateDelayTime = 2;

  private readonly logger = new Logger(this.constructor.name);

  constructor(
    private readonly prismaService: PrismaService,
    private readonly configService: ConfigService,
  ) {
    const { url } =
      this.configService.get<ConfigurationType['platform']>('platform')!;
    this.updateDelayTime =
      this.configService.get<ConfigurationType['feed']>(
        'feed',
      )!.updateDelayTime;

    this.request = Axios.create({ baseURL: url, timeout: 15 * 1e3 });

    this.request.interceptors.response.use(
      (response) => {
        return response;
      },
      async (error) => {
        this.logger.log('error: ', error);
        const errMsg = error.response?.data?.message || '';

        const id = (error.config.headers as any).xid;
        if (errMsg.includes('WeReadError401')) {
          // 账号失效
          await this.prismaService.account.update({
            where: { id },
            data: { status: statusMap.INVALID },
          });
          this.logger.error(`账号（${id}）登录失效，已禁用`);
        } else if (errMsg.includes('WeReadError429')) {
          //TODO 处理请求频繁
          this.logger.error(`账号（${id}）请求频繁，打入小黑屋`);
        }

        const today = this.getTodayDate();

        const blockedAccounts = blockedAccountsMap.get(today);

        if (Array.isArray(blockedAccounts)) {
          if (id) {
            blockedAccounts.push(id);
          }
          blockedAccountsMap.set(today, blockedAccounts);
        } else if (errMsg.includes('WeReadError400')) {
          this.logger.error(`账号（${id}）处理请求参数出错`);
          this.logger.error('WeReadError400: ', errMsg);
          // 10s 后重试
          await new Promise((resolve) => setTimeout(resolve, 10 * 1e3));
        } else {
          this.logger.error("Can't handle this error: ", errMsg);
        }

        return Promise.reject(error);
      },
    );
  }

  removeBlockedAccount = (vid: string) => {
    const today = this.getTodayDate();

    const blockedAccounts = blockedAccountsMap.get(today);
    if (Array.isArray(blockedAccounts)) {
      const newBlockedAccounts = blockedAccounts.filter((id) => id !== vid);
      blockedAccountsMap.set(today, newBlockedAccounts);
    }
  };

  private getTodayDate() {
    return dayjs.tz(new Date(), 'Asia/Shanghai').format('YYYY-MM-DD');
  }

  getBlockedAccountIds() {
    const today = this.getTodayDate();
    const disabledAccounts = blockedAccountsMap.get(today) || [];
    this.logger.debug('disabledAccounts: ', disabledAccounts);
    return disabledAccounts.filter(Boolean);
  }

  private async getAvailableAccount() {
    const disabledAccounts = this.getBlockedAccountIds();
    const account = await this.prismaService.account.findMany({
      where: {
        status: statusMap.ENABLE,
        NOT: {
          id: { in: disabledAccounts },
        },
      },
      take: 10,
    });

    if (!account || account.length === 0) {
      throw new Error('暂无可用账号!');
    }

    return account[Math.floor(Math.random() * account.length)];
  }

  async getMpArticles(mpId: string, page = 1, retryCount = 3) {
    const account = await this.getAvailableAccount();

    try {
      const res = await this.request
        .get<
          {
            id: string;
            title: string;
            picUrl: string;
            publishTime: number;
          }[]
        >(`/api/v2/platform/mps/${mpId}/articles`, {
          headers: {
            xid: account.id,
            Authorization: `Bearer ${account.token}`,
          },
          params: {
            page,
          },
        })
        .then((res) => res.data)
        .then((res) => {
          this.logger.log(
            `getMpArticles(${mpId}) page: ${page} articles: ${res.length}`,
          );
          return res;
        });
      return res;
    } catch (err) {
      this.logger.error(`retry(${4 - retryCount}) getMpArticles  error: `, err);
      if (retryCount > 0) {
        return this.getMpArticles(mpId, page, retryCount - 1);
      } else {
        throw err;
      }
    }
  }

  async refreshMpArticlesAndUpdateFeed(
    mpId: string,
    page = 1,
  ): Promise<RefreshArticlesResult> {
    try {
      const articles = await this.getMpArticles(mpId, page);

      if (articles.length > 0) {
        let results;
        const { type } =
          this.configService.get<ConfigurationType['database']>('database')!;
        if (type === 'sqlite') {
          // sqlite3 不支持 createMany
          const inserts = articles.map(({ id, picUrl, publishTime, title }) =>
            this.prismaService.article.upsert({
              create: { id, mpId, picUrl, publishTime, title },
              update: {
                publishTime,
                title,
              },
              where: { id },
            }),
          );
          results = await this.prismaService.$transaction(inserts);
        } else {
          results = await (this.prismaService.article as any).createMany({
            data: articles.map(({ id, picUrl, publishTime, title }) => ({
              id,
              mpId,
              picUrl,
              publishTime,
              title,
            })),
            skipDuplicates: true,
          });
        }

        this.logger.debug(
          `refreshMpArticlesAndUpdateFeed create results: ${JSON.stringify(
            results,
          )}`,
        );
      }

      // 如果文章数量小于 defaultCount，则认为没有更多历史文章
      const hasHistory = articles.length < defaultCount ? 0 : 1;

      await this.prismaService.feed.update({
        where: { id: mpId },
        data: {
          syncTime: Math.floor(Date.now() / 1e3),
          hasHistory,
        },
      });

      return {
        message: `成功更新订阅源 ${mpId}。`,
        successCount: 1,
        errorCount: 0,
        failedFeeds: [],
        hasHistory,
        articlesCount: articles.length,
      };
    } catch (error) {
      this.logger.error(`更新订阅源 ${mpId} 失败:`, error);
      return {
        message: `更新订阅源 ${mpId} 失败。`,
        successCount: 0,
        errorCount: 1,
        failedFeeds: [mpId],
        hasHistory: 1, // 失败时，假设还有历史，以便可以重试
        articlesCount: 0,
      };
    }
  }

  inProgressHistoryMp = {
    id: '',
    page: 1,
  };

  async getHistoryMpArticles(mpId: string) {
    if (this.inProgressHistoryMp.id === mpId) {
      this.logger.log(`getHistoryMpArticles(${mpId}) is running`);
      return;
    }

    this.inProgressHistoryMp = {
      id: mpId,
      page: 1,
    };

    if (!this.inProgressHistoryMp.id) {
      return;
    }

    try {
      const feed = await this.prismaService.feed.findFirstOrThrow({
        where: {
          id: mpId,
        },
      });

      // 如果完整同步过历史文章，则直接返回
      if (feed.hasHistory === 0) {
        this.logger.log(`getHistoryMpArticles(${mpId}) has no history`);
        return;
      }

      const total = await this.prismaService.article.count({
        where: {
          mpId,
        },
      });
      this.inProgressHistoryMp.page = Math.ceil(total / defaultCount);

      // 最多尝试一千次
      let i = 1e3;
      while (i-- > 0) {
        if (this.inProgressHistoryMp.id !== mpId) {
          this.logger.log(
            `getHistoryMpArticles(${mpId}) is not running, break`,
          );
          break;
        }
		
        const { hasHistory = 1 } = await this.refreshMpArticlesAndUpdateFeed(
          mpId,
          this.inProgressHistoryMp.page,
        );

        if (hasHistory < 1) {
          this.logger.log(
            `getHistoryMpArticles(${mpId}) has no history, break`,
          );
          break;
        }
        this.inProgressHistoryMp.page++;

        await new Promise((resolve) =>
          setTimeout(resolve, this.updateDelayTime * 1e3),
        );
      }
    } finally {
      this.inProgressHistoryMp = {
        id: '',
        page: 1,
      };
    }
  }

  isRefreshAllMpArticlesRunning = false;

  async refreshAllMpArticlesAndUpdateFeed(): Promise<Omit<RefreshArticlesResult, 'articlesCount'>> {
    if (this.isRefreshAllMpArticlesRunning) {
      this.logger.log('refreshAllMpArticlesAndUpdateFeed is running');
      // 如果已经在运行，返回一个特定的状态
      return {
        message: '任务已在运行中',
        successCount: -1, // 使用特殊值表示非正常结束
        errorCount: -1,
        failedFeeds: [],
      };
    }
    this.isRefreshAllMpArticlesRunning = true;
    try {
      const allMps = await this.prismaService.feed.findMany({
        where: { status: statusMap.ENABLE },
      });
      if (allMps.length === 0) {
        this.logger.log('没有需要更新的启用状态的订阅源。');
        return {
          message: '没有需要更新的启用状态的订阅源。',
          successCount: 0,
          errorCount: 0,
          failedFeeds: [],
        };
      }
      let feedsToUpdate = allMps.map((mp) => mp.id);
      let finalFailedFeeds: string[] = [];
      // 设置最多尝试的轮数
      const maxRounds = 8;
      for (let round = 1; round <= maxRounds; round++) {
        this.logger.log(
          `--- 开始第 ${round}/${maxRounds} 轮更新，共 ${feedsToUpdate.length} 个订阅源 ---`,
        );
        const currentRoundFailedFeeds = new Set<string>();
        for (const id of feedsToUpdate) {
          try {
            const result = await this.refreshMpArticlesAndUpdateFeed(id);
            if (result.errorCount > 0 || result.articlesCount === 0) {
              currentRoundFailedFeeds.add(id);
            }
          } catch (error) {
            this.logger.error(
              `在第 ${round} 轮更新订阅源 ${id} 时出错：`,
              (error as Error).message,
            );
            currentRoundFailedFeeds.add(id);
          }
          // 在处理列表中的下一个订阅源之前等待
          await new Promise((resolve) =>
            setTimeout(resolve, this.updateDelayTime * 1e3),
          );
        }
        finalFailedFeeds = Array.from(currentRoundFailedFeeds);
        if (finalFailedFeeds.length === 0) {
          this.logger.log(
            `--- 第 ${round} 轮所有订阅源更新成功。 ---`,
          );
          break;
        }
        feedsToUpdate = finalFailedFeeds;
        if (round < maxRounds) {
          this.logger.log(
            `--- 第 ${round} 轮更新结束。${finalFailedFeeds.length} 个订阅源更新失败。正在重试... ---`,
          );
        }
      }
      // 最终日志记录
      const successCount = allMps.length - finalFailedFeeds.length;
      const errorCount = finalFailedFeeds.length;
      this.logger.log('--- 全部更新流程结束。 ---');
      this.logger.log(`成功更新：${successCount} 个订阅源。`);
      if (errorCount > 0) {
        this.logger.error(`更新失败：${errorCount} 个订阅源。`);
        this.logger.error(
          `以下订阅源ID更新失败：${finalFailedFeeds.join(', ')}`,
        );
      }
      // 返回最终结果
      return {
        message: '更新流程结束',
        successCount,
        errorCount,
        failedFeeds: finalFailedFeeds,
      };
    } catch (e) {
      this.logger.error(
        '在执行 refreshAllMpArticlesAndUpdateFeed 期间发生意外错误：',
        e,
      );
      // 发生未知错误时也返回错误信息
      return {
        message: '发生意外错误',
        successCount: 0,
        errorCount: (
          await this.prismaService.feed.findMany({
            where: { status: statusMap.ENABLE },
          })
        ).length,
        failedFeeds: [],
      };
    } finally {
      this.isRefreshAllMpArticlesRunning = false;
    }
  }

  async getMpInfo(url: string) {
    url = url.trim();
    const account = await this.getAvailableAccount();

    return this.request
      .post<
        {
          id: string;
          cover: string;
          name: string;
          intro: string;
          updateTime: number;
        }[]
      >(
        `/api/v2/platform/wxs2mp`,
        { url },
        {
          headers: {
            xid: account.id,
            Authorization: `Bearer ${account.token}`,
          },
        },
      )
      .then((res) => res.data);
  }

  async createLoginUrl() {
    return this.request
      .get<{
        uuid: string;
        scanUrl: string;
      }>(`/api/v2/login/platform`)
      .then((res) => res.data);
  }

  async getLoginResult(id: string) {
    return this.request
      .get<{
        message: string;
        vid?: number;
        token?: string;
        username?: string;
      }>(`/api/v2/login/platform/${id}`, { timeout: 120 * 1e3 })
      .then((res) => res.data);
  }
}
