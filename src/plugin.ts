import { md5Ascii } from "./md5";

const TIEBA_HOST = "tieba.baidu.com";
const TIEBA_ORIGIN = "https://" + TIEBA_HOST;
const LOGIN_URL = "https://wappass.baidu.com/passport/?login&tpl=tb&u=https%3A%2F%2Ftieba.baidu.com%2Fmo%2Fq%2Ffrs%3Fkw%3D%25E6%2595%25B0%25E7%25A0%2581";
const ACCOUNT_PATH = "/mo/q/newmoindex?need_user=1";
const CATALOG_PATH = "/mg/o/getForumHome?st=0&pn=0&rn=50&eqid=&refer=";
const FORUM_GUIDE_PATH = "/c/f/forum/forumGuide";
const FOLLOWED_PAGE_SIZE = 100;
const PC_FORUM_SIGN_SALT = "36770b1f34c9bbf2e7d1a99d2b82fa9e";
const LANGUAGE = ["zh-CN"];
const JSON_HEADERS = {
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "zh-CN,zh;q=0.9",
  Referer: TIEBA_ORIGIN + "/",
  "User-Agent": "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
  "X-Requested-With": "XMLHttpRequest",
};

const CAPABILITIES = {
  "flare.datasource.timeline/v1": ["page"],
  "flare.datasource.tab-catalog/v1": ["page"],
  "flare.datasource.post/v1": ["detail", "context"],
  "flare.datasource.search/v1": ["posts", "profiles", "discoverPosts", "discoverProfiles", "discoverHashtags"],
  "flare.datasource.profile/v1": ["byId", "byHandle"],
};

type JsonObject = Record<string, unknown>;
type TiebaCookie = { name: string; value: string };
type FloorPage = { floors: Floor[]; nextOffset?: number; forum?: string; repliesCount?: number };

type Floor = {
  pid: string;
  index: number;
  author?: ProfileV1;
  title: string;
  content: string;
  time: string;
  media: MediaV1[];
  repliesCount?: number;
};

defineFlareSocialPlugin({
  detector: {
    detect({ origin }) {
      if (origin.toLowerCase() !== TIEBA_ORIGIN) return { match: "none", canonicalOrigin: origin };
      return {
        match: "exact",
        canonicalOrigin: TIEBA_ORIGIN,
        software: "Baidu Tieba",
        instance: { domain: TIEBA_HOST, title: "百度贴吧" },
      };
    },
  },
  login: {
    browser: {
      begin() {
        return { type: "webCookie", startUrl: LOGIN_URL };
      },
      async check(request, context) {
        const probe = context.origin + ACCOUNT_PATH;
        const cookies = request.cookies.cookies
          .filter((cookie) => cookie.sourceUrl === probe && cookie.value)
          .map(({ name, value }) => ({ name, value }));
        if (!cookies.some(({ name }) => name === "BDUSS" || name === "BDUSS_BFESS")) {
          return { type: "pending" };
        }
        const profile = await verifiedAccount(context.origin, cookies);
        if (!profile) return { type: "pending" };
        return {
          type: "success",
          value: {
            accountId: profile.key.id,
            origin: context.origin,
            credential: { cookies },
            profile,
            capabilities: CAPABILITIES,
          },
        };
      },
    },
  },
  capabilities: {
    timeline: {
      async page(request, context) {
        const { timelineId, page } = request;
        if (timelineId === "hot") return pageRows(await hotTopics(context), page);
        if (timelineId === "recommend") return loadRecommendations(page, context);
        const forum = text(request.parameters.kw || page.parameters.kw || timelineId.match(/^forum:(.+)$/)?.[1]).trim();
        if (!forum) fail("Unsupported", "找不到此时间线对应的贴吧");
        return loadForum(forum, page, context);
      },
    },
    tabCatalog: { page: loadCatalog },
    search: {
      posts: loadPostSearch,
      async profiles({ query, page }, context) {
        if (!query.trim()) return { items: [], endReached: true };
        const { batch, skip } = pagePosition(page);
        const { users, hasMore } = await searchUsers(query.trim(), batch, context);
        return pageRows(users, page, { batch, skip }, hasMore);
      },
      discoverPosts: ({ page }, context) => loadRecommendations(page, context),
      async discoverProfiles({ page }, context) {
        const { batch, skip } = pagePosition(page);
        const { items, hasMore } = await recommendedPosts(batch, context);
        const profiles = new Map<string, ProfileV1>();
        for (const { post } of items) {
          if (post.author) profiles.set(post.author.key.id, post.author);
        }
        return pageRows([...profiles.values()], page, { batch, skip }, hasMore);
      },
      async discoverHashtags({ page }, context) {
        const topics = await hotTopics(context);
        return pageRows(topics.map(({ feed }) => ({ name: feed.title ?? "", url: feed.url })), page);
      },
    },
    profile: {
      async byId(request, context) {
        const id = request.key.id;
        if (context.accountId === id) {
          const profile = await verifiedAccount(context.origin, await readCookies(context));
          if (profile?.key.id === id) return profile;
          fail("AuthenticationRequired", "贴吧登录已失效，请重新登录");
        }
        return findProfile(id, context);
      },
      async byHandle({ handle }, context) {
        return findProfile(handle, context);
      },
    },
    post: {
      async detail({ key: { id } }, context) {
        return { post: await loadPostDetail(id, context) };
      },
      async context(request, context) {
        const id = request.key.id;
        const ref = postRef(id);
        if (!ref) fail("NotFound", "找不到这篇帖子");
        const page = request.page;
        const { batch, skip } = pagePosition(page, 0);
        const refresh = page.direction === "refresh";
        if (ref.parent) {
          const items = refresh ? [{ type: "post" as const, post: await loadPostDetail(id, context) }] : [];
          return { items, endReached: true };
        }
        const parent = ref.pid ? { pid: ref.pid, key: id, offset: ref.offset ?? 0 } : undefined;
        const loaded = await (parent ? loadSubfloors(ref.tid, parent.pid, batch, context) : loadFloors(ref.tid, batch, context));
        const items: TimelineItemV1[] = loaded.floors.filter(({ index }) => parent || index !== 1).map((floor) => ({
          type: "post" as const,
          post: {
            ...mapFloor(floor, ref.tid, replyKey(ref.tid, floor.pid, batch, parent), parent),
            replyTo: request.key,
          },
        }));
        const result = pageRows(items, { ...page, limit: page.limit - Number(refresh) },
          { batch, skip }, loaded.nextOffset !== undefined, loaded.nextOffset);
        if (refresh) {
          // Flare renders context rows directly, including the selected post at the top.
          const post = parent
            ? await loadPostDetail(id, context)
            : await mapMainPost(firstFloor(loaded.floors), ref.tid, id, loaded.forum ?? "", loaded.repliesCount, context);
          result.items?.unshift({ type: "post", post });
        }
        return result;
      },
    },
  },
});

async function verifiedAccount(origin: string, cookies: TiebaCookie[]): Promise<ProfileV1 | undefined> {
  const response = await hostRequest(origin + ACCOUNT_PATH, cookies);
  if ([401, 403].includes(response.status)) return undefined;
  requireStatus(response);
  const data = asObject(parseJsonObject(response.body)?.data);
  if (!data) return undefined;
  const user = asObject(data.user) ?? asObject(data.user_info) ?? data;
  if (!isTrue(data.is_login ?? user.is_login)) return undefined;
  const id = numericId(user.uid || user.id || user.user_id || data.uid);
  if (id && id !== "0") return mapUser(user, id);
  const catalog = await hostRequest(origin + CATALOG_PATH, cookies);
  if (catalog.status !== 200) return undefined;
  const profile = asObject(asObject(parseJsonObject(catalog.body)?.data)?.user_info);
  const catalogId = numericId(profile?.id);
  return isTrue(profile?.is_login) && catalogId && catalogId !== "0"
    ? mapUser({ ...user, ...profile }, catalogId)
    : undefined;
}

async function loadCatalog(page: PageRequestV1, context: PluginInvocationContextV1): Promise<PageV1<TimelineSectionV1>> {
  const cookies = await readCookies(context);
  if (page.direction === "older") {
    const next = /^followed:(\d+)$/.exec(page.cursor ?? "");
    const batch = positiveInt(next?.[1]);
    if (!batch || !cookies.length) fail("Validation", "关注吧的分页位置无效");
    const followed = await loadFollowedPage(batch, context, cookies);
    return forumCatalog(followed.rows, [], followed.next);
  }
  if (page.direction !== "refresh") return { items: [], endReached: true };

  const data = await requestData(CATALOG_PATH, context);
  const recommended = asArray(data.recomm_forum);
  if (!cookies.length) return forumCatalog([], recommended);

  const homeFollowed = asArray(asObject(data.like_forum)?.list ?? data.like_forum);
  const guide = await loadForumGuide(context, cookies).catch(() => undefined);
  const completeGuide = guide && guide.rows.length < 200 && !guide.hasMore && guide.rows.length >= homeFollowed.length;
  if (completeGuide) return forumCatalog(guide.rows, recommended);

  const paged = await loadFollowedPage(1, context, cookies).catch(() => undefined);
  if (paged && (paged.rows.length || paged.next)) return forumCatalog(paged.rows, recommended, paged.next);
  return forumCatalog(guide?.rows.length ? guide.rows : homeFollowed, recommended);
}

async function loadForumGuide(context: PluginInvocationContextV1, cookies: TiebaCookie[]) {
  const response = await hostRequest(context.origin + FORUM_GUIDE_PATH, cookies, false, {
    method: "POST",
    headers: { "Subapp-Type": "hybrid" },
    body: { type: "form", values: { sort_type: "3", call_from: "3" } },
  });
  requireStatus(response);
  const root = parseJsonObject(response.body);
  if (Number(root?.error_code) !== 0 || !Array.isArray(root?.like_forum)) {
    fail("InvalidResponse", "贴吧没有返回关注吧列表");
  }
  return { rows: root.like_forum as unknown[], hasMore: isTrue(root.like_forum_has_more) };
}

async function loadFollowedPage(batch: number, context: PluginInvocationContextV1, cookies: TiebaCookie[]) {
  const profile = await verifiedAccount(context.origin, cookies);
  const portrait = profile?.avatarUrl?.match(/\/([\w.-]+)(?:[?#]|$)/)?.[1];
  if (!profile || profile.key.id !== context.accountId || !portrait) {
    fail("AuthenticationRequired", "请登录贴吧后查看完整关注列表");
  }
  const query = {
    _client_type: "20",
    pn: String(batch),
    portrait,
    rn: String(FOLLOWED_PAGE_SIZE),
    subapp_type: "pc",
  };
  const parts = Object.entries(query).map(([name, value]) => name + "=" + value);
  // Tieba's desktop endpoint uses a legacy MD5 request checksum for these public parameters.
  const sign = md5Ascii(parts.join("") + PC_FORUM_SIGN_SALT);
  const response = await hostRequest(context.origin + "/c/f/pc/myForumList?" + parts.join("&") + "&sign=" + sign, cookies);
  requireStatus(response);
  const root = parseJsonObject(response.body);
  const data = asObject(root?.data);
  if (Number(root?.error_code) !== 0 || !data || !Array.isArray(data.like)) {
    fail("InvalidResponse", "贴吧没有返回关注吧的分页数据");
  }
  const rows = data.like as unknown[];
  return { rows, next: rows.length && isTrue(data.has_more) ? "followed:" + (batch + 1) : undefined };
}

function forumCatalog(followed: unknown[], recommended: unknown[], cursor?: string): PageV1<TimelineSectionV1> {
  const seen = new Set<string>();
  const sections: TimelineSectionV1[] = [];
  for (const [id, title, forums] of [
    ["liked", { key: "catalog.followed", fallback: "Followed forums" }, followed],
    ["recommended", { key: "catalog.recommended", fallback: "Recommended forums" }, recommended],
  ] as const) {
    const items: TimelineDescriptorV1[] = [];
    for (const value of forums) {
      const forum = asObject(value);
      const name = text(forum?.forum_name ?? forum?.name).trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      const forumId = numericId(forum?.forum_id ?? forum?.id);
      items.push({
        id: forumId ? "forum-" + forumId : "forum",
        title: { value: name + "吧" },
        icon: "List",
        parameters: { kw: name },
      });
    }
    if (items.length) sections.push({ id, title, timelines: { items, endReached: true } });
  }
  return { items: sections, olderCursor: cursor, endReached: cursor === undefined };
}

async function hotTopics(context: PluginInvocationContextV1): Promise<{ type: "feed"; feed: FeedV1 }[]> {
  const data = await requestData("/hottopic/browse/topicList", context);
  const entries = asArray(asObject(data.bang_topic)?.topic_list);
  return entries.flatMap((value) => {
    const topic = asObject(value);
    const id = numericId(topic?.topic_id);
    const title = text(topic?.topic_name).trim();
    if (!topic || !id || !title) return [];
    const url = TIEBA_ORIGIN + "/hottopic/browse/hottopic?topic_id=" + id + "&topic_name=" + encodeURIComponent(title);
    const picture = httpsUrl(text(topic.topic_pic));
    const summary = text(topic.topic_desc ?? topic.abstract);
    return [{
      type: "feed",
      feed: {
        url,
        title,
        createdAt: postTime(topic.create_time),
        source: { name: "贴吧热议" },
        description: summary ? { format: "plain", value: summary } : undefined,
        media: picture ? { id: "hot-" + id, type: "image", url: picture } : undefined,
        sourceLanguages: LANGUAGE,
      },
    }];
  });
}

async function recommendedPosts(batch: number, context: PluginInvocationContextV1) {
  const data = await requestData("/mo/q/recommend?pn=" + batch, context);
  const rows = [...asArray(data.hot_thread_list), ...asArray(data.video_thread_list)];
  return { items: mapThreads(rows), hasMore: rows.length > 0 };
}

async function loadRecommendations(page: PageRequestV1, context: PluginInvocationContextV1): Promise<PageV1<TimelineItemV1>> {
  const position = pagePosition(page);
  const { items, hasMore } = await recommendedPosts(position.batch, context);
  return pageRows(items, page, position, hasMore);
}

async function loadForum(forum: string, page: PageRequestV1, context: PluginInvocationContextV1): Promise<PageV1<TimelineItemV1>> {
  const position = pagePosition(page, 0);
  const path = "/mo/q/frs?kw=" + encodeURIComponent(forum) + "&pn=" + position.batch;
  const response = await requestSite(path, context, true);
  const html = response.body;
  const list = inlineJson(html, /\bthread_list:\s*(?=\[)/);
  if (!Array.isArray(list)) {
    if (/本吧暂不开放|该吧不存在|此吧不存在/.test(html)) fail("NotFound", "这个贴吧暂不可用");
    fail("InvalidResponse", "贴吧没有返回帖子列表");
  }
  const info = asObject(inlineJson(html, /\bpage:\s*(?=\{"req_num":)/));
  const size = positiveInt(info?.page_size) ?? 30;
  const offset = numberOrUndefined(info?.offset) ?? position.batch;
  const next = offset + size;
  const hasMore = list.length > 0 && next < (positiveInt(info?.total_page) ?? 1) * size && next > position.batch;
  return pageRows(mapThreads(list, forum), page, position, hasMore, next);
}

async function loadPostSearch({ query, page }: SearchRequestV1, context: PluginInvocationContextV1): Promise<PageV1<TimelineItemV1>> {
  const word = query.trim();
  if (!word) return { items: [], endReached: true };
  const position = pagePosition(page);
  const suffix = "?word=" + encodeURIComponent(word) + "&pn=" + position.batch;
  const data = await requestData("/mo/q/search/thread" + suffix, context);
  const posts: TimelineItemV1[] = mapThreads(asArray(data.post_list));
  if (position.batch === 1) {
    // The search surface has no forum entity. Put an exact forum match above the posts.
    const forums = await requestData("/mo/q/search/forum" + suffix, context).catch(() => undefined);
    const forum = asObject(forums?.exactMatch);
    const name = text(forum?.forum_name);
    if (name) {
      const image = httpsUrl(text(forum?.avatar));
      posts.unshift({
        type: "feed",
        feed: {
          url: TIEBA_ORIGIN + "/mo/q/frs?kw=" + encodeURIComponent(name),
          title: name + "吧",
          description: { format: "plain", value: text(forum?.intro ?? forum?.slogan) },
          createdAt: postTime(),
          source: { name: "百度贴吧" },
          media: image ? { id: "forum-" + name, type: "image", url: image } : undefined,
          sourceLanguages: LANGUAGE,
        },
      });
    }
  }
  return pageRows(posts, page, position, isTrue(data.has_more));
}

async function searchUsers(query: string, batch: number, context: PluginInvocationContextV1) {
  const data = await requestData("/mo/q/search/user?word=" + encodeURIComponent(query) + "&pn=" + batch, context);
  const unique = new Map<string, ProfileV1>();
  for (const value of [data.exactMatch, ...asArray(data.fuzzyMatch)]) {
    const user = mapUser(value);
    if (user) unique.set(user.key.id, user);
  }
  return { users: [...unique.values()], hasMore: isTrue(data.has_more) };
}

async function findProfile(handle: string, context: PluginInvocationContextV1): Promise<ProfileV1> {
  const { users } = await searchUsers(handle, 1, context);
  const profile = users.find((user) => user.key.id === handle || user.handle === handle);
  if (!profile) fail("NotFound", "找不到这位吧友");
  return profile;
}

function mapThreads(rows: unknown[], forum?: string): { type: "post"; post: PostV1 }[] {
  const posts = new Map<string, PostV1>();
  for (const value of rows) {
    const thread = asObject(value);
    const tid = numericId(thread?.tid ?? thread?.id);
    if (!thread || !tid || posts.has(tid)) continue;
    const title = text(thread.title ?? thread.thread_title).trim();
    const summary = text(thread.abstract ?? thread.thread_abstract ?? thread.content).trim();
    const media = threadMedia(thread, tid);
    const parts = [title && "<b>" + escapeHtml(title) + "</b>", summary && escapeHtml(summary).replace(/\n/g, "<br>")];
    posts.set(tid, {
      key: key(tid),
      author: mapUser(thread.author ?? thread.user ?? thread),
      createdAt: postTime(thread.create_time ?? thread.time ?? thread.last_time_int),
      content: { format: "html", value: parts.filter(Boolean).join("<br>") || " " },
      detailType: "post",
      url: threadUrl(tid),
      media,
      repliesCount: numberOrUndefined(thread.reply_num ?? thread.post_num),
      favouritesCount: numberOrUndefined(thread.agree_num ?? thread.like_num),
      sourceChannel: forumChannel(forum ?? text(thread.forum_name), thread.forum_id),
      sourceLanguages: LANGUAGE,
    });
  }
  return [...posts.values()].map((post) => ({ type: "post", post }));
}

function threadMedia(thread: JsonObject, tid: string): MediaV1[] {
  const media: MediaV1[] = [];
  for (const value of asArray(thread.media)) {
    const item = asObject(value);
    if (!item || text(item.type) !== "pic") continue;
    const url = httpsUrl(text(item.big_pic || item.src_pic || item.water_pic || item.static_img));
    if (!url || media.some((image) => image.url === url)) continue;
    media.push({
      id: tid + "-m" + media.length,
      type: /\.gif(?:[?#]|$)/i.test(url) ? "gif" : "image",
      url,
      previewUrl: httpsUrl(text(item.water_pic || item.small_pic)),
      width: positiveInt(item.width),
      height: positiveInt(item.height),
    });
  }
  const video = asObject(thread.video_info) ?? asObject(asArray(thread.video_info)[0]);
  const videoUrl = httpsUrl(text(video?.video_url || video?.play_url || thread.video_url));
  if (videoUrl) {
    media.unshift({
      id: tid + "-video",
      type: "video",
      url: videoUrl,
      previewUrl: httpsUrl(text(video?.thumbnail_url || video?.cover_url || thread.pic_url)),
      width: positiveInt(video?.width ?? thread.video_width),
      height: positiveInt(video?.height ?? thread.video_height),
    });
  }
  const picture = httpsUrl(text(thread.pic_url));
  if (!media.length && picture) media.push({ id: tid + "-m0", type: "image", url: picture });
  return media.slice(0, 9);
}

function mapUser(value: unknown, accountId?: string): ProfileV1 | undefined {
  const user = asObject(value);
  if (!user) return undefined;
  const name = text(user.user_name ?? user.name ?? user.un).trim();
  const display = text(user.show_nickname || user.name_show || user.name_nickname || user.user_nickname).trim();
  const id = accountId ?? name;
  if (!id) return undefined;
  return {
    key: key(id),
    handle: name || id,
    displayName: display || name || id,
    avatarUrl: avatarUrl(text(user.portrait_url || user.portrait)),
    description: text(user.intro) ? { format: "plain", value: text(user.intro) } : undefined,
    followersCount: numberOrUndefined(user.fans_num),
    url: name ? TIEBA_ORIGIN + "/home/main?un=" + encodeURIComponent(name) : undefined,
  };
}

async function loadPostDetail(id: string, context: PluginInvocationContextV1): Promise<PostV1> {
  const ref = postRef(id);
  if (!ref) fail("NotFound", "找不到这篇帖子");
  if (ref.pid && ref.parent) {
    const page = await loadSubfloors(ref.tid, ref.parent.pid, ref.offset ?? 0, context);
    const floor = page.floors.find(({ pid }) => pid === ref.pid);
    if (floor) return mapFloor(floor, ref.tid, id, ref.parent);
    fail("NotFound", "找不到这条楼中楼回复");
  }
  let offset = ref.offset ?? 0;
  for (let attempt = 0; attempt < 4; attempt++) {
    const page = await loadFloors(ref.tid, offset, context);
    const floor = ref.pid ? page.floors.find(({ pid }) => pid === ref.pid) : firstFloor(page.floors);
    if (floor) return mapMainPost(floor, ref.tid, id, page.forum ?? "", ref.pid ? undefined : page.repliesCount, context);
    // Existing reply keys did not carry the offset.
    if (ref.offset !== undefined || page.nextOffset === undefined) break;
    offset = page.nextOffset;
  }
  fail("NotFound", "找不到这条帖子或回复");
}

function firstFloor(floors: Floor[]): Floor {
  const floor = floors.find(({ index }) => index === 1);
  if (!floor) fail("NotFound", "楼主的正文暂不可用");
  return floor;
}

async function mapMainPost(floor: Floor, tid: string, id: string, forum: string,
  repliesCount: number | undefined, context: PluginInvocationContextV1): Promise<PostV1> {
  const post = mapFloor(floor, tid, id, undefined, forum);
  if (repliesCount !== undefined) post.repliesCount = repliesCount;
  if (floor.media.some(({ type }) => type === "image" || type === "gif")) {
    const originals = await loadOriginalImages(tid, floor.pid, context).catch(() => []);
    if (originals.length) post.media = [...originals, ...floor.media.filter(({ type }) => type === "video")];
  }
  return post;
}

async function loadFloors(tid: string, offset: number, context: PluginInvocationContextV1): Promise<FloorPage> {
  const path = "/mo/q/pb?kz=" + tid + "&pn=" + (offset || 1);
  if (offset === 0) {
    const html = (await requestSite(path, context, true)).body;
    const floors = parseFloors(html);
    if (!floors.length) fail("NotFound", "这篇帖子已删除、受限或暂时无法查看");
    const info = asObject(inlineJson(html, /\bpage:\s*(?=\{"req_num":)/));
    const forum = text(inlineJson(html, /\bforum_name:\s*(?=")/));
    const thread = asObject(inlineJson(html, /\bthreadInfo:\s*(?=\{)/));
    return { floors, nextOffset: nextFloorOffset(info, offset), forum, repliesCount: numberOrUndefined(thread?.reply_num) };
  }
  const data = await requestData(path + "&is_ajax=1", context);
  return { floors: parseFloors(text(data.html)), nextOffset: nextFloorOffset(asObject(data.page), offset), forum: "", repliesCount: undefined };
}

async function loadSubfloors(tid: string, parent: string, offset: number, context: PluginInvocationContextV1): Promise<FloorPage> {
  const data = await requestData("/mo/q/flr?kz=" + tid + "&pid=" + parent + "&pnum=" + (offset || 1), context);
  const info = asObject(data.page);
  const current = positiveInt(info?.current_page) ?? 1;
  const total = positiveInt(info?.total_page) ?? 1;
  return {
    floors: parseFloors(text(data.floor_html), true),
    nextOffset: current < total && current + 1 > offset ? current + 1 : undefined,
  };
}

async function loadOriginalImages(tid: string, pid: string, context: PluginInvocationContextV1): Promise<MediaV1[]> {
  const data = await requestData("/photo/bw/picture/guide?tid=" + tid, context);
  return Object.values(asObject(data.pic_list) ?? {}).flatMap((value) => {
    const picture = asObject(value);
    if (numericId(picture?.post_id) !== pid) return [];
    const image = asObject(picture?.img);
    const original = asObject(image?.original);
    const url = httpsUrl(text(original?.waterurl || original?.url));
    if (!url) return [];
    return [{
      id: pid + "-m" + text(picture?.index),
      type: /\.gif(?:[?#]|$)/i.test(url) ? "gif" as const : "image" as const,
      url,
      previewUrl: httpsUrl(text(asObject(image?.medium)?.url)),
      width: positiveInt(original?.width),
      height: positiveInt(original?.height),
    }];
  }).slice(0, 9);
}

function nextFloorOffset(page: JsonObject | undefined, requested: number): number | undefined {
  const current = positiveInt(page?.current_page) ?? 1;
  const total = positiveInt(page?.total_page) ?? 1;
  const next = current * (positiveInt(page?.page_size) ?? 30);
  return current < total && next > requested ? next : undefined;
}

function parseFloors(html: string, nested = false): Floor[] {
  const className = nested ? "j_list_item_floor" : "j_post_list_item";
  const starts = [...html.matchAll(/<li\b[^>]*>/gi)].filter((match) =>
    attribute(match[0], "class").split(/\s+/).includes(className));
  const floors: Floor[] = [];
  for (const [index, start] of starts.entries()) {
    const body = html.slice(start.index + start[0].length, starts[index + 1]?.index);
    const info = parseJsonObject(attribute(start[0], "data-info"));
    const pid = numericId(info?.pid ?? attribute(start[0], nested ? "pid" : "tid"));
    if (!pid) continue;
    const content = classContent(body, nested ? "span" : "div", nested ? "floor_content" : "content");
    const media = floorMedia(content, pid);
    const author = mapUser({
      name: info?.un,
      name_show: info?.name_show ?? (nested ? stripTags(classContent(body, "a", "user_name")).trim().replace(/[:：]$/, "") : undefined),
      portrait: info?.portrait,
    });
    floors.push({
      pid,
      index: positiveInt(info?.floor_num ?? attribute(start[0], "fn")) ?? 0,
      author,
      title: stripTags(classContent(body, "div", "post_title_embed")).trim(),
      content: displayFloorContent(content),
      time: stripTags(classContent(body, "span", "list_item_time")).trim(),
      media,
      repliesCount: nested ? undefined : numberOrUndefined(attribute(classTag(body, "div", "j_floor_panel")?.[0] ?? "", "data-list-count")),
    });
  }
  return floors;
}

function mapFloor(floor: Floor, tid: string, id: string, parent?: ParentFloor, forum?: string): PostV1 {
  const thread = !postRef(id)?.pid;
  const title = thread && floor.title ? "<b>" + escapeHtml(floor.title) + "</b><br>" : "";
  return {
    key: key(id),
    author: floor.author,
    createdAt: parseTiebaTime(floor.time) ?? postTime(),
    content: { format: "html", value: (title + floor.content).trim() || " " },
    media: floor.media,
    detailType: "post",
    url: thread ? threadUrl(tid) : threadUrl(tid) + "?pid=" + (parent?.pid ?? floor.pid) + "#" + floor.pid,
    replyTo: thread ? undefined : key(parent?.key ?? tid),
    repliesCount: floor.repliesCount,
    sourceChannel: forumChannel(forum ?? ""),
    sourceLanguages: LANGUAGE,
  };
}

function floorMedia(html: string, pid: string): MediaV1[] {
  const items: MediaV1[] = [];
  const signedVideo = classTag(html, "span", "net_search_url");
  const videoUrl = httpsUrl(attribute(signedVideo?.[0] ?? "", "data-vhsrc"));
  if (videoUrl) {
    const preview = /<a\b[^>]*\bdata-vhsrc=[^>]*>[\s\S]*?<\/a>/i.exec(html);
    const poster = preview?.[0].match(/<img\b[^>]*>/i)?.[0] ?? "";
    items.push({ id: pid + "-video", type: "video", url: videoUrl, previewUrl: httpsUrl(attribute(poster, "src")) });
    if (preview) html = html.replace(preview[0], "");
  }
  for (const match of html.matchAll(/<(?:img|div|video|source)\b[^>]*>/gi)) {
    const tag = match[0];
    const embedded = attribute(tag, "data-url");
    const url = httpsUrl(attribute(tag, "data-original") || embedded || attribute(tag, "src"));
    if (!url || /\/tb\/(?:editor|cms\/nickemoji)\//i.test(url) || items.some((item) => item.url === url)) continue;
    const isVideo = /^<(?:video|source)\b/i.test(tag);
    items.push({
      id: pid + "-m" + items.length,
      type: isVideo ? "video" : /\.gif(?:[?#]|$)/i.test(url) ? "gif" : "image",
      url,
      previewUrl: isVideo ? httpsUrl(attribute(tag, "poster")) : undefined,
      description: attribute(tag, "alt") || undefined,
      width: positiveInt(attribute(tag, "width")),
      height: positiveInt(attribute(tag, "height")),
    });
    if (items.length === 9) break;
  }
  return items;
}

function displayFloorContent(html: string): string {
  // Render regular photos in Flare's native media gallery. Keep small inline emoji in the text.
  return html
    .replace(/<(script|style|video)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<a\b[^>]*\bdata-vhsrc=[^>]*>[\s\S]*?<\/a>/gi, "")
    .replace(/<div\b[^>]*class=["'][^"']*\bj_videoFootDownBtn\b[^"']*["'][^>]*>[\s\S]*?<\/div>/gi, "")
    .replace(/<div\b[^>]*class=["'][^"']*\bpb_less_imgs\b[^"']*["'][^>]*>[\s\S]*$/i, "")
    .replace(/<img\b[^>]*>/gi, (tag) => {
      const src = httpsUrl(attribute(tag, "src"));
      if (src && /\/tb\/editor\//i.test(src)) return '<img src="' + escapeHtml(src) + '" alt="' + escapeHtml(attribute(tag, "alt")) + '">';
      return "";
    })
    .replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\bhref=(["'])(\/[^/"'][^"']*)\1/gi, (_link, quote: string, path: string) => "href=" + quote + TIEBA_ORIGIN + path + quote)
    .trim();
}

function classTag(html: string, tag: string, name: string) {
  return [...html.matchAll(new RegExp("<" + tag + "\\b[^>]*>", "gi"))].find((match) =>
    attribute(match[0], "class").split(/\s+/).includes(name));
}

function classContent(html: string, tag: string, name: string): string {
  const start = classTag(html, tag, name);
  if (!start) return "";
  const offset = start.index + start[0].length;
  const tags = new RegExp("<(/?)" + tag + "\\b[^>]*>", "gi");
  tags.lastIndex = offset;
  let depth = 1;
  for (let match = tags.exec(html); match; match = tags.exec(html)) {
    depth += match[1] ? -1 : 1;
    if (depth === 0) return html.slice(offset, match.index);
  }
  return "";
}

function attribute(tag: string, name: string): string {
  const value = new RegExp("(?:^|\\s)" + name + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))", "i").exec(tag);
  return value ? decodeEntities(value[1] ?? value[2] ?? value[3]) : "";
}

function inlineJson(html: string, marker: RegExp): unknown {
  const match = marker.exec(html);
  if (!match) return undefined;
  const start = match.index + match[0].length;
  const tokens = /"(?:[^"\\]|\\[\s\S])*"|[\[\]{}]/g;
  tokens.lastIndex = start;
  let depth = 0;
  for (let token = tokens.exec(html); token; token = tokens.exec(html)) {
    if (token[0] === "{" || token[0] === "[") depth++;
    if (token[0] === "}" || token[0] === "]") depth--;
    if (depth === 0) {
      try { return JSON.parse(html.slice(start, tokens.lastIndex)); }
      catch { return undefined; }
    }
  }
  return undefined;
}

function pagePosition(page: PageRequestV1, first = 1): { batch: number; skip: number } {
  if (page.direction === "refresh") return { batch: first, skip: 0 };
  const match = /^(\d+)(?::(\d+))?$/.exec(page.cursor ?? "");
  const batch = Number(match?.[1]);
  const skip = Number(match?.[2] ?? 0);
  if (page.direction !== "older" || !Number.isSafeInteger(batch) || !Number.isSafeInteger(skip)) {
    fail("Validation", "分页位置无效，请刷新后重试");
  }
  return { batch, skip };
}

function pageRows<T>(
  rows: T[],
  page: PageRequestV1,
  position = pagePosition(page),
  hasMore = false,
  nextBatch = position.batch + 1,
): PageV1<T> {
  const items = rows.slice(position.skip, position.skip + page.limit);
  const end = position.skip + items.length;
  const olderCursor = end < rows.length
    ? position.batch + ":" + end
    : hasMore ? String(nextBatch) : undefined;
  return { items, olderCursor, endReached: olderCursor === undefined };
}

type ParentFloor = { pid: string; key: string; offset: number };

function postRef(id: string): { tid: string; pid?: string; offset?: number; parent?: ParentFloor } | undefined {
  const thread = /^t?(\d+)$/.exec(id);
  if (thread) return { tid: thread[1] };
  const reply = /^p(\d+)_(\d+)(?:_(\d+)(?:_(\d+)_(\d+))?)?$/.exec(id);
  if (!reply) return undefined;
  const [, tid, pid, offset, parent, parentOffset] = reply;
  const parentPage = Number(parentOffset);
  return {
    tid,
    pid,
    offset: numberOrUndefined(offset),
    parent: parent ? { pid: parent, offset: parentPage, key: replyKey(tid, parent, parentPage) } : undefined,
  };
}

function replyKey(tid: string, pid: string, offset: number, parent?: ParentFloor): string {
  return "p" + tid + "_" + pid + "_" + offset + (parent ? "_" + parent.pid + "_" + parent.offset : "");
}

function key(id: string): EntityKeyV1 {
  return { id, host: TIEBA_HOST };
}

function threadUrl(tid: string): string {
  return TIEBA_ORIGIN + "/p/" + tid;
}

function forumChannel(name: string, id?: unknown): PostV1["sourceChannel"] {
  return name ? { id: numericId(id) ?? name, name: name + "吧" } : undefined;
}

function httpsUrl(value: string): string | undefined {
  const url = decodeEntities(value).trim()
    .replace(/^\/\//, "https://")
    .replace(/^http:\/\//i, "https://")
    .replace(/^https:\/\/[a-z0-9-]+\.hiphotos\.baidu\.com\//i, "https://imgsrc.baidu.com/")
    .replace(/^https:\/\/tb\.himg\.baidu\.com\//i, "https://himg.bdimg.com/");
  return /^https:\/\/[a-z0-9.-]+(?::\d+)?(?:[/?#]|$)/i.test(url) && !/[\s<>"']/.test(url) ? url : undefined;
}

function avatarUrl(portrait: string): string | undefined {
  return httpsUrl(portrait) ?? (/^[\w.-]+(?:\?t=\d+)?$/.test(portrait) ? "https://himg.bdimg.com/sys/portrait/item/" + portrait : undefined);
}

async function requestSite(path: string, context: PluginInvocationContextV1, html = false): Promise<HttpResponseV1> {
  const response = await hostRequest(context.origin + path, await readCookies(context), html);
  requireStatus(response);
  return response;
}

async function requestData(path: string, context: PluginInvocationContextV1): Promise<JsonObject> {
  const response = await requestSite(path, context);
  const root = parseJsonObject(response.body);
  if (!root) fail("InvalidResponse", "贴吧返回了无法读取的页面");
  const code = root.no ?? root.errno;
  if (code !== undefined && Number(code) !== 0) {
    const message = text(root.error || root.errmsg);
    if (/not logined|未登录|没有登录|请登录/i.test(message)) fail("AuthenticationRequired", "请登录贴吧后重试");
    fail("Remote", message || "贴吧接口暂不可用");
  }
  const data = asObject(root.data);
  if (!data) fail("InvalidResponse", "贴吧返回的数据不完整");
  return data;
}

async function readCookies(context: PluginInvocationContextV1): Promise<TiebaCookie[]> {
  if (context.scope !== "account" || !context.credentialAvailable) return [];
  const credential = asObject(await flare.credential.read());
  return asArray(credential?.cookies).flatMap((entry) => {
    const cookie = asObject(entry);
    const name = text(cookie?.name);
    const value = text(cookie?.value);
    return name && value ? [{ name, value }] : [];
  });
}

async function hostRequest(url: string, cookies: TiebaCookie[], html = false,
  options?: Pick<HttpRequestV1, "method" | "headers" | "body">): Promise<HttpResponseV1> {
  try {
    return await flare.http.request({
      ...options,
      url,
      cookies,
      headers: {
        ...JSON_HEADERS,
        ...(html ? { Accept: "text/html,application/xhtml+xml,*/*;q=0.8" } : {}),
        ...options?.headers,
      },
    });
  } catch (error) {
    if (asObject(error)?.code === "host.unavailable") fail("Network", "暂时无法连接贴吧");
    throw error;
  }
}

function requireStatus(response: HttpResponseV1) {
  if (response.status === 401) fail("AuthenticationRequired", "请重新登录贴吧");
  if (response.status === 403) fail("Remote", "百度安全验证拦截了请求，请稍后重试");
  if (response.status === 404) fail("NotFound", "贴吧页面不存在");
  if (response.status === 429) fail("RateLimited", "贴吧请求过于频繁，请稍后重试");
  if (response.status < 200 || response.status >= 300) fail("Remote", "贴吧暂时无法返回数据");
}

function parseJsonObject(body: string): JsonObject | undefined {
  try { return asObject(JSON.parse(body)); }
  catch { return undefined; }
}

function asObject(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  return typeof value === "number" ? String(value) : "";
}

function numericId(value: unknown): string | undefined {
  if (typeof value === "number" && !Number.isSafeInteger(value)) return undefined;
  const id = text(value);
  return /^\d+$/.test(id) ? id : undefined;
}

function positiveInt(value: unknown): number | undefined {
  const number = numberOrUndefined(value);
  return number && number > 0 ? number : undefined;
}

function isTrue(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}

function postTime(value?: unknown): string {
  return isoFromEpoch(value) ?? new Date().toISOString();
}
function numberOrUndefined(value: unknown): number | undefined {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : undefined;
}

function isoFromEpoch(value: unknown): string | undefined {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value)
        ? Number(value)
        : NaN;
  const date = new Date(parsed * 1000);
  return parsed > 0 && Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function parseTiebaTime(value: string): string | undefined {
  const source = value.trim();
  if (!source) return undefined;
  const now = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  const day = now.getUTCDate();
  let match = /^今天\s*(\d{1,2}):(\d{2})$/.exec(source);
  if (match) {
    return isoShanghai(year, month, day, Number(match[1]), Number(match[2]));
  }
  match = /^昨天\s*(\d{1,2}):(\d{2})$/.exec(source);
  if (match) {
    const previous = new Date(Date.UTC(year, month - 1, day));
    previous.setUTCDate(previous.getUTCDate() - 1);
    return isoShanghai(
      previous.getUTCFullYear(),
      previous.getUTCMonth() + 1,
      previous.getUTCDate(),
      Number(match[1]),
      Number(match[2]),
    );
  }
  match = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?$/.exec(source);
  if (match) {
    return isoShanghai(
      Number(match[1]),
      Number(match[2]),
      Number(match[3]),
      Number(match[4] ?? 0),
      Number(match[5] ?? 0),
    );
  }
  match = /^(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?$/.exec(source);
  if (match) {
    return isoShanghai(
      year,
      Number(match[1]),
      Number(match[2]),
      Number(match[3] ?? 0),
      Number(match[4] ?? 0),
    );
  }
  return undefined;
}

function isoShanghai(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): string {
  return (
    String(year) +
    "-" +
    pad2(month) +
    "-" +
    pad2(day) +
    "T" +
    pad2(hour) +
    ":" +
    pad2(minute) +
    ":00+08:00"
  );
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function decodeEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function stripTags(value: string): string {
  return decodeEntities(value.replace(/<[^>]*>/g, ""));
}

function fail(code: PluginErrorCodeV1, message: string): never {
  throw flare.error({ code, message: { value: message } });
}
