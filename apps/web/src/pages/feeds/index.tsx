import {
  Avatar,
  Button,
  Divider,
  Listbox,
  ListboxItem,
  ListboxSection,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Switch,
  Textarea,
  Tooltip,
  useDisclosure,
  Link,
  Select,
  SelectItem,
} from '@nextui-org/react';
import { PlusIcon } from '@web/components/PlusIcon';
import { trpc } from '@web/utils/trpc';
import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import dayjs from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat';
import { serverOriginUrl } from '@web/utils/env';
import ArticleList from './list';
import { Document, Packer, Paragraph, TextRun, ExternalHyperlink } from 'docx';
import { saveAs } from 'file-saver';

dayjs.extend(customParseFormat);

const Feeds = () => {
  const { id } = useParams();

  const { isOpen, onOpen, onOpenChange, onClose } = useDisclosure();
  const { refetch: refetchFeedList, data: feedData } = trpc.feed.list.useQuery(
    {},
    {
      refetchOnWindowFocus: true,
    },
  );

  const navigate = useNavigate();

  const queryUtils = trpc.useUtils();

  const { mutateAsync: getMpInfo, isLoading: isGetMpInfoLoading } =
    trpc.platform.getMpInfo.useMutation({});
  const { mutateAsync: updateMpInfo } = trpc.feed.edit.useMutation({});

  const { mutateAsync: addFeed, isLoading: isAddFeedLoading } =
    trpc.feed.add.useMutation({});
  const { mutateAsync: refreshMpArticles, isLoading: isGetArticlesLoading } =
    trpc.feed.refreshArticles.useMutation();
  const {
    mutateAsync: getHistoryArticles,
    isLoading: isGetHistoryArticlesLoading,
  } = trpc.feed.getHistoryArticles.useMutation();

  const { data: inProgressHistoryMp, refetch: refetchInProgressHistoryMp } =
    trpc.feed.getInProgressHistoryMp.useQuery(undefined, {
      refetchOnWindowFocus: true,
      refetchInterval: 10 * 1e3,
      refetchOnMount: true,
      refetchOnReconnect: true,
    });

  const { data: isRefreshAllMpArticlesRunning } =
    trpc.feed.isRefreshAllMpArticlesRunning.useQuery();

  const { mutateAsync: deleteFeed, isLoading: isDeleteFeedLoading } =
    trpc.feed.delete.useMutation({});

  const [wxsLink, setWxsLink] = useState('');

  const [currentMpId, setCurrentMpId] = useState(id || '');
  const [timeRange, setTimeRange] = useState('yesterday');

  const handleConfirm = async () => {
    console.log('wxsLink', wxsLink);
    // TODO show operation in progress
    const wxsLinks = wxsLink.split('\n').filter((link) => link.trim() !== '');
    for (const link of wxsLinks) {
      console.log('add wxsLink', link);
      const res = await getMpInfo({ wxsLink: link });
      if (res[0]) {
        const item = res[0];
        await addFeed({
          id: item.id,
          mpName: item.name,
          mpCover: item.cover,
          mpIntro: item.intro,
          updateTime: item.updateTime,
          status: 1,
        });
        await refreshMpArticles({ mpId: item.id });
        toast.success('添加成功', {
          description: `公众号 ${item.name}`,
        });
        await queryUtils.article.list.reset();
      } else {
        toast.error('添加失败', { description: '请检查链接是否正确' });
      }
    }
    refetchFeedList();
    setWxsLink('');
    onClose();
  };

  const isActive = (key: string) => {
    return currentMpId === key;
  };

  const currentMpInfo = useMemo(() => {
    return feedData?.items.find((item) => item.id === currentMpId);
  }, [currentMpId, feedData?.items]);

  const handleExportOpml = async (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (!feedData?.items?.length) {
      console.warn('没有订阅源');
      return;
    }

    let opmlContent = `<?xml version="1.0" encoding="UTF-8"?>
    <opml version="2.0">
      <head>
        <title>WeWeRSS 所有订阅源</title>
      </head>
      <body>
    `;

    feedData?.items.forEach((sub) => {
      opmlContent += `    <outline text="${sub.mpName}" type="rss" xmlUrl="${window.location.origin}/feeds/${sub.id}.atom" htmlUrl="${window.location.origin}/feeds/${sub.id}.atom"/>\n`;
    });

    opmlContent += `    </body>
    </opml>`;

    const blob = new Blob([opmlContent], { type: 'text/xml;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'WeWeRSS-All.opml';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleExportDoc = async () => {
    const now = dayjs();
    let startTime;

    switch (timeRange) {
      case 'today':
        startTime = now.startOf('day');
        break;
      case 'yesterday':
        startTime = now.subtract(1, 'day').startOf('day');
        break;
      case 'day_before_yesterday':
        startTime = now.subtract(2, 'day').startOf('day');
        break;
      case 'three_days_ago':
        startTime = now.subtract(3, 'day').startOf('day');
        break;
      default:
        startTime = now.subtract(1, 'day').startOf('day');
    }

    const startTimeUnix = startTime.unix();
    const endTimeUnix = now.unix();

    try {
      const response = await fetch(`${serverOriginUrl}/feeds/all.txt?startTime=${startTimeUnix}&endTime=${endTimeUnix}&limit=999`);
      if (!response.ok) {
        toast.error(`网络响应错误: ${response.statusText}`);
        return;
      }
      const textContent = await response.text();

      if (!textContent.trim()) {
        toast.info('该时间范围内没有内容可导出');
        return;
      }

      const articles = textContent.trim().split('\n\n').map(block => {
        const lines = block.split('\n');
        return {
          title: lines[0],
          time: lines[1],
          link: lines[2],
        };
      });

      const doc = new Document({
        styles: {
          paragraphStyles: [
            {
              id: "Hyperlink",
              name: "Hyperlink",
              basedOn: "Normal",
              next: "Normal",
              quickFormat: true,
              run: {
                color: "0000FF",
                underline: {
                  type: "single",
                  color: "0000FF",
                },
              },
            },
          ]
        },
        sections: [{
          children: articles.flatMap(article => [
            new Paragraph({
              children: [new TextRun(article.title)],
              spacing: { after: 120 }, // 约等于 6pt
            }),
            new Paragraph({
              children: [new TextRun(article.time)],
              spacing: { after: 120 },
            }),
            new Paragraph({
              children: [
                new ExternalHyperlink({
                  children: [
                    new TextRun({
                      text: article.link,
                      style: "Hyperlink",
                    }),
                  ],
                  link: article.link,
                }),
              ],
              spacing: { after: 240 }, // 约等于 12pt, 制造段间距
            }),
          ]),
        }],
      });

      const firstDate = dayjs(articles[articles.length - 1].time, "YYYY-M-D_HH:mm:ss").format('MM.DD');
      const lastDate = dayjs(articles[0].time, "YYYY-M-D_HH:mm:ss").format('MM.DD');
      const filename = `星火选题库(${firstDate}_${lastDate}).docx`;

      Packer.toBlob(doc).then(blob => {
        saveAs(blob, filename);
        toast.success('导出成功!');
      });

    } catch (error) {
      console.error('导出失败:', error);
      toast.error('导出失败，请查看控制台获取更多信息。');
    }
  };

  // @ts-ignore
  return (
    <>
      <div className="h-full flex justify-between">
        <div className="w-64 p-4 h-full">
          <div className="pb-4 flex justify-between align-middle items-center">
            <Button
              color="primary"
              size="sm"
              onPress={onOpen}
              endContent={<PlusIcon />}
            >
              添加
            </Button>
            <div className="font-normal text-sm">
              共{feedData?.items.length || 0}个订阅
            </div>
          </div>

          {feedData?.items ? (
            <Listbox
              aria-label="订阅源"
              emptyContent="暂无订阅"
              onAction={(key) => setCurrentMpId(key as string)}
            >
              <ListboxSection showDivider>
                <ListboxItem
                  key={''}
                  href={`/feeds`}
                  onClick={(e) => {
                    e.preventDefault();
                    navigate('/feeds');
                  }}
                  className={isActive('') ? 'bg-primary-50 text-primary' : ''}
                  startContent={<Avatar name="ALL"></Avatar>}
                >
                  全部
                </ListboxItem>
              </ListboxSection>

              <ListboxSection className="overflow-y-auto h-[calc(100vh-260px)]">
                {feedData?.items.map((item) => {
                  return (
                    <ListboxItem
                      href={`/feeds/${item.id}`}
                      onClick={(e) => {
                        e.preventDefault();
                        navigate(`/feeds/${item.id}`);
                      }}
                      className={
                        isActive(item.id) ? 'bg-primary-50 text-primary' : ''
                      }
                      key={item.id}
                      startContent={<Avatar src={item.mpCover}></Avatar>}
                    >
                      {item.mpName}
                    </ListboxItem>
                  );
                }) || []}
              </ListboxSection>
            </Listbox>
          ) : (
            ''
          )}
        </div>
        <div className="flex-1 h-full flex flex-col">
          <div className="p-4 pb-0 flex justify-between">
            <h3 className="text-medium font-mono flex-1 overflow-hidden text-ellipsis break-keep text-nowrap pr-1">
              {currentMpInfo?.mpName || '全部'}
            </h3>
            {currentMpInfo ? (
              <div className="flex h-5 items-center space-x-4 text-small">
                <div className="font-light">
                  最后更新时间:
                  {dayjs(currentMpInfo.syncTime * 1e3).format(
                    'YYYY-MM-DD HH:mm:ss',
                  )}
                </div>
                <Divider orientation="vertical" />
                <Tooltip
                  content="频繁调用可能会导致一段时间内不可用"
                  color="danger"
                >
                  <Link
                    size="sm"
                    href="#"
                    isDisabled={isGetArticlesLoading}
                    onClick={async (ev) => {
                      ev.preventDefault();
                      ev.stopPropagation();
                      await refreshMpArticles({ mpId: currentMpInfo.id });
                      await refetchFeedList();
                      await queryUtils.article.list.reset();
                    }}
                  >
                    {isGetArticlesLoading ? '更新中...' : '立即更新'}
                  </Link>
                </Tooltip>
                <Divider orientation="vertical" />
                {currentMpInfo.hasHistory === 1 && (
                  <>
                    <Tooltip
                      content={
                        inProgressHistoryMp?.id === currentMpInfo.id
                          ? `正在获取第${inProgressHistoryMp.page}页...`
                          : `历史文章需要分批次拉取，请耐心等候，频繁调用可能会导致一段时间内不可用`
                      }
                      color={
                        inProgressHistoryMp?.id === currentMpInfo.id
                          ? 'primary'
                          : 'danger'
                      }
                    >
                      <Link
                        size="sm"
                        href="#"
                        isDisabled={
                          (inProgressHistoryMp?.id
                            ? inProgressHistoryMp?.id !== currentMpInfo.id
                            : false) ||
                          isGetHistoryArticlesLoading ||
                          isGetArticlesLoading
                        }
                        onClick={async (ev) => {
                          ev.preventDefault();
                          ev.stopPropagation();

                          if (inProgressHistoryMp?.id === currentMpInfo.id) {
                            await getHistoryArticles({
                              mpId: '',
                            });
                          } else {
                            await getHistoryArticles({
                              mpId: currentMpInfo.id,
                            });
                          }

                          await refetchInProgressHistoryMp();
                        }}
                      >
                        {inProgressHistoryMp?.id === currentMpInfo.id
                          ? `停止获取历史文章`
                          : `获取历史文章`}
                      </Link>
                    </Tooltip>
                    <Divider orientation="vertical" />
                  </>
                )}

                <Tooltip content="启用服务端定时更新">
                  <div>
                    <Switch
                      size="sm"
                      onValueChange={async (value) => {
                        await updateMpInfo({
                          id: currentMpInfo.id,
                          data: {
                            status: value ? 1 : 0,
                          },
                        });

                        await refetchFeedList();
                      }}
                      isSelected={currentMpInfo?.status === 1}
                    ></Switch>
                  </div>
                </Tooltip>
                <Divider orientation="vertical" />
                <Tooltip content="仅删除订阅源，已获取的文章不会被删除">
                  <Link
                    href="#"
                    color="danger"
                    size="sm"
                    isDisabled={isDeleteFeedLoading}
                    onClick={async (ev) => {
                      ev.preventDefault();
                      ev.stopPropagation();

                      if (confirm('确定删除吗？')) {
                        await deleteFeed(currentMpInfo.id);
                        navigate('/feeds');
                        await refetchFeedList();
                      }
                    }}
                  >
                    删除
                  </Link>
                </Tooltip>

                <Divider orientation="vertical" />
                <Tooltip
                  content={
                    <div>
                      可添加.atom/.rss/.json格式输出, limit=20&page=1控制分页
                    </div>
                  }
                >
                  <Link
                    size="sm"
                    showAnchorIcon
                    target="_blank"
                    href={`${serverOriginUrl}/feeds/${currentMpInfo.id}.atom`}
                    color="foreground"
                  >
                    RSS
                  </Link>
                </Tooltip>
              </div>
            ) : (
              <div className="flex gap-2 items-center">
                <Tooltip
                  content="频繁调用可能会导致一段时间内不可用"
                  color="danger"
                >
                  <Link
                    size="sm"
                    href="#"
                    isDisabled={
                      isRefreshAllMpArticlesRunning || isGetArticlesLoading
                    }
                    onClick={async (ev) => {
                      ev.preventDefault();
                      ev.stopPropagation();

                      // 调用 mutation 并等待结果
                      const result = await refreshMpArticles({});

                      // 根据返回结果显示不同的 toast
                      if (result && result.errorCount > 0) {
                        // 失败ID储存
                        const failedIdsText = result.failedFeeds.join('\n');

                        const toastId = toast.error(
                          `更新失败：${result.errorCount} 个订阅源。`,
                          {
                            description: `失败的ID: ${result.failedFeeds.join(', ')}`,
                            // 设置一个非常大的持续时间，使其不会自动关闭
                            duration: Infinity,
                            action: {
                              label: '复制并关闭',
                              onClick: async () => {
                                try {
                                  await navigator.clipboard.writeText(failedIdsText);
                                  toast.success('复制成功');
                                } catch (err) {
                                  console.error('复制失败: ', err);
                                  toast.error('复制失败，请检查浏览器设置');
                                } finally {
                                  toast.dismiss(toastId);
                                }
                              },
                            },
                          }
                        );
                      } else if (result && result.successCount >= 0) {
                        toast.success(`更新完成`, {
                          description: `成功更新：${result.successCount} 个订阅源。`,
                        });
                      } else if (result) {
                        // 处理任务已在运行中或其他特殊情况
                        toast.info(result.message || '未知状态');
                      }
                      await refetchFeedList();
                      await queryUtils.article.list.reset();
                    }}
                  >
                    {isRefreshAllMpArticlesRunning || isGetArticlesLoading
                      ? '更新中...'
                      : '更新全部'}
                  </Link>
                </Tooltip>

                <Divider orientation="vertical" />

                <Select
                  size="sm"
                  className="w-32 flex-shrink-0"
                  selectedKeys={[timeRange]}
                  onChange={(e) => {
                    // 只有当选择的值不为空时才更新状态
                    if (e.target.value) {
                      setTimeRange(e.target.value);
                    }
                  }}
                  aria-label="时间范围选择"
                >
                  <SelectItem key="today" value="today">今天</SelectItem>
                  <SelectItem key="yesterday" value="yesterday">昨天至今</SelectItem>
                  <SelectItem key="day_before_yesterday" value="day_before_yesterday">前天至今</SelectItem>
                  <SelectItem key="three_days_ago" value="three_days_ago">大前天至今</SelectItem>
                </Select>
                <Button
                  size="sm"
                  color="primary"
                  variant="flat"
                  onClick={handleExportDoc}
                >
                  导出选题
                </Button>
              </div>
            )}
          </div>
          <div className="p-2 overflow-y-auto">
            <ArticleList></ArticleList>
          </div>
        </div>
      </div>
      <Modal isOpen={isOpen} onOpenChange={onOpenChange}>
        <ModalContent>
          {(onClose) => (
            <>
              <ModalHeader className="flex flex-col gap-1">
                添加公众号源
              </ModalHeader>
              <ModalBody>
                <Textarea
                  value={wxsLink}
                  onValueChange={setWxsLink}
                  autoFocus
                  label="分享链接"
                  placeholder="输入公众号文章分享链接，一行一条，如 https://mp.weixin.qq.com/s/xxxxxx https://mp.weixin.qq.com/s/xxxxxx"
                  variant="bordered"
                />
              </ModalBody>
              <ModalFooter>
                <Button color="danger" variant="flat" onPress={onClose}>
                  取消
                </Button>
                <Button
                  color="primary"
                  isDisabled={
                    !wxsLink.trim() || !wxsLink.includes('https://mp.weixin.qq.com/s/')
                  }
                  onPress={handleConfirm}
                  isLoading={
                    isAddFeedLoading ||
                    isGetMpInfoLoading ||
                    isGetArticlesLoading
                  }
                >
                  确定
                </Button>
              </ModalFooter>
            </>
          )}
        </ModalContent>
      </Modal>
    </>
  );
};

export default Feeds;
