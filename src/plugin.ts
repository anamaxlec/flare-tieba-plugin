const TIMELINE_CAPABILITY = "flare.datasource.timeline/v1";
const TAB_CATALOG_CAPABILITY = "flare.datasource.tab-catalog/v1";
const POST_CAPABILITY = "flare.datasource.post/v1";

const THREADS_PER_PAGE = 30;
const MAX_THREAD_PAGES = 20;

const TIEBA_HOST = "tieba.baidu.com";
const TIEBA_ORIGIN = "https://" + TIEBA_HOST;

const JSON_HEADERS = {
  Accept: "application/json, text/plain, */*",
  "X-Requested-With": "com.baidu.tieba",
};

type JsonObject = Record<string, unknown>;
type TiebaCookie = { name: string; value: string };

type ThreadFloor = {
  tid: string;
  pid: string;
  floor: number;
  userName: string;
  displayName: string;
  portrait: string;
  contentHtml: string;
  title: string;
  timeText: string;
};

defineFlareSocialPlugin({
  detector: {
    detect(request) {
      if (request.origin.toLowerCase() !== TIEBA_ORIGIN) {
        return { match: "none", canonicalOrigin: request.origin };
      }
      return {
        match: "exact",
        canonicalOrigin: request.origin,
        software: "Baidu Tieba",
        instance: {
          domain: TIEBA_HOST,
          title: "百度贴吧",
          description: "Baidu Tieba forums, threads and replies",
        },
      };
    },
  },
  login: {
    browser: {
      async begin(_request, context) {
        return { type: "webCookie", startUrl: context.origin + "/" };
      },
      async check(request, context) {
        const probeUrl = context.origin + "/mo/q/newmoindex?need_user=1";
        const cookies = request.cookies.cookies
          .filter((cookie) => cookie.sourceUrl === probeUrl)
          .map(({ name, value }) => ({ name, value }));
        if (!hasCookie(cookies, "BDUSS") || !hasCookie(cookies, "BAIDUID")) {
          return { type: "pending" };
        }
        const response = await hostRequest({
          url: probeUrl,
          cookies,
          headers: JSON_HEADERS,
        });
        if (response.status < 200 || response.status >= 300) {
          fail("Remote", "The website rejected the sign-in check");
        }
        const root = parseJsonObject(response.body);
        const data = asObject(root?.data);
        if (!data || !isLoggedIn(data.is_login)) return { type: "pending" };
        const uid = text(data.uid);
        if (!/^\d+$/.test(uid)) return { type: "pending" };
        const handle = text(data.name).trim() || uid;
        const displayName = text(data.name_show).trim() || handle;
        return {
          type: "success",
          value: {
            accountId: uid,
            origin: context.origin,
            credential: { cookies },
            profile: {
              key: { id: uid, host: accountHost(context) },
              handle,
              displayName,
              avatarUrl: avatarUrl(text(data.portrait_url)),
            },
            capabilities: {
              [TIMELINE_CAPABILITY]: ["page"],
              [TAB_CATALOG_CAPABILITY]: ["page"],
              [POST_CAPABILITY]: ["detail", "context"],
            },
          },
        };
      },
    },
  },
  capabilities: {
    timeline: {
      async page(request, context) {
        if (request.page.direction === "newer") {
          fail("Unsupported", "This timeline does not support newer pages");
        }
        if (request.timelineId === "hot") {
          return loadHot(request.page, context);
        }
        const parameters = { ...request.page.parameters, ...request.parameters };
        const forum = text(parameters.kw).trim();
        if (!forum) fail("Unsupported", "This timeline does not identify a forum");
        return loadForum(forum, request.page, context);
      },
    },
    tabCatalog: {
      async page(_request, context) {
        const data = await requestData(
          "/mg/o/getForumHome?st=0&pn=0&rn=50&eqid=&refer=",
          context,
        );
        const sections: TimelineSectionV1[] = [];
        const liked = forumDescriptors(asObject(data.like_forum)?.list);
        if (liked.length) {
          sections.push({
            id: "liked",
            title: { value: "我关注的吧" },
            timelines: { items: liked, endReached: true },
          });
        }
        const recommended = forumDescriptors(data.recomm_forum);
        if (recommended.length) {
          sections.push({
            id: "recommended",
            title: { value: "推荐吧" },
            timelines: { items: recommended, endReached: true },
          });
        }
        return { items: sections, endReached: true };
      },
    },
    post: {
      async detail(request, context) {
        const id = request.key.id;
        const tid = threadIdOf(id);
        if (!tid) fail("NotFound", "The requested thread does not exist");
        if (id.startsWith("p")) {
          const pid = id.slice(id.indexOf("_") + 1);
          for (let page = 1; page <= 4; page += 1) {
            const floors = parseThreadPage(
              await requestHtml(threadPagePath(tid, page), context),
            );
            const floor = floors.find((item) => item.pid === pid);
            if (floor) return { post: mapFloor(floor, tid, context, true) };
            if (!floors.length) break;
          }
          fail("NotFound", "The requested reply does not exist");
        }
        const floors = parseThreadPage(
          await requestHtml(threadPagePath(tid, 1), context),
        );
        const first = floors[0];
        if (!first) fail("NotFound", "The requested thread does not exist");
        return { post: mapThreadDetail(first, tid, context) };
      },
      async context(request, context) {
        const tid = threadIdOf(request.key.id);
        if (!tid) fail("NotFound", "The requested thread does not exist");
        const page =
          request.page.direction === "refresh"
            ? 1
            : parsePositiveInt(request.page.cursor);
        if (page === null || page > MAX_THREAD_PAGES) {
          fail("Validation", "Invalid page cursor");
        }
        const floors = parseThreadPage(
          await requestHtml(threadPagePath(tid, page), context),
        );
        if (!floors.length) return { items: [], endReached: true };
        const visible = page === 1 ? floors.slice(1) : floors;
        const items: TimelineItemV1[] = visible
          .slice(0, request.page.limit)
          .map((floor) => ({
            type: "post" as const,
            post: mapFloor(floor, tid, context, false),
          }));
        return {
          items,
          olderCursor: String(page + 1),
          endReached: false,
        };
      },
    },
  },
});

async function loadHot(
  page: PageRequestV1,
  context: PluginInvocationContextV1,
): Promise<PageV1<TimelineItemV1>> {
  if (page.direction !== "refresh") return { items: [], endReached: true };
  const data = await requestData("/mo/q/hotMessage/list?fr=newwise", context);
  const list = asObject(data.list);
  const entries = list && Array.isArray(list.ret) ? list.ret : [];
  const items: TimelineItemV1[] = [];
  for (const entry of entries) {
    const item = mapHotTopic(entry);
    if (item) items.push(item);
    if (items.length >= page.limit) break;
  }
  return { items, endReached: true };
}

async function loadForum(
  forum: string,
  page: PageRequestV1,
  context: PluginInvocationContextV1,
): Promise<PageV1<TimelineItemV1>> {
  const start = page.direction === "refresh" ? 0 : parsePositiveInt(page.cursor);
  if (start === null || page.cursor === undefined || page.cursor === "") {
    if (page.direction !== "refresh") fail("Validation", "Invalid page cursor");
  }
  const offset = start === null ? 0 : start;
  const pageNumber = Math.floor(offset / THREADS_PER_PAGE);
  const offsetInPage = offset % THREADS_PER_PAGE;
  const data = await requestData(
    "/f?kw=" +
      encodeURIComponent(forum) +
      "&pn=" +
      String(pageNumber * THREADS_PER_PAGE) +
      "&fr=newwise",
    context,
  );
  const frs = asObject(data.frs_data);
  if (!frs) fail("InvalidResponse", "The forum response was incomplete");
  const threads = Array.isArray(frs.thread_list) ? frs.thread_list : [];
  if (!threads.length) return { items: [], endReached: true };
  const info = asObject(frs.page) ?? {};
  const currentPage = numberOr(info.current_page, pageNumber + 1);
  const totalPage = numberOr(info.total_page, currentPage);
  const slice = threads.slice(offsetInPage, offsetInPage + page.limit);
  const items: TimelineItemV1[] = [];
  for (const thread of slice) {
    const item = mapThread(thread, context);
    if (item) items.push(item);
  }
  const nextOffset = offset + slice.length;
  const endReached =
    currentPage >= totalPage && offsetInPage + slice.length >= threads.length;
  return {
    items,
    olderCursor: endReached || !slice.length ? undefined : String(nextOffset),
    endReached,
  };
}

function mapHotTopic(value: unknown): TimelineItemV1 | undefined {
  const entry = asObject(value);
  if (!entry) return undefined;
  const id = text(entry.re_id).trim();
  const title = text(entry.mul_name).trim();
  if (!id || !title) return undefined;
  const info = asObject(entry.topic_info) ?? {};
  const createdAt = isoFromEpoch(entry.create_time) ?? new Date().toISOString();
  const picture = text(info.head_pic);
  return {
    type: "feed",
    feed: {
      url:
        "https://tieba.baidu.com/mo/q/hotMessage?topic_id=" +
        encodeURIComponent(id) +
        "&topic_name=" +
        encodeURIComponent(title),
      createdAt,
      source: { name: "贴吧热议" },
      title,
      description: {
        format: "plain",
        value: text(entry.share_sub_title) || text(info.topic_desc),
      },
      media: picture
        ? { id: "hot-" + id, type: "image", url: normalizeUrl(picture) }
        : undefined,
    },
  };
}

function mapThread(
  value: unknown,
  context: PluginInvocationContextV1,
): TimelineItemV1 | undefined {
  const thread = asObject(value);
  if (!thread) return undefined;
  const tid = text(thread.tid) || text(thread.id);
  if (!/^\d+$/.test(tid)) return undefined;
  const media = mapThreadMedia(thread, tid);
  const post: PostV1 = {
    key: { id: "t" + tid, host: accountHost(context) },
    author: mapUser(thread.author, context),
    createdAt:
      isoFromEpoch(thread.create_time) ??
      isoFromEpoch(thread.last_time_int) ??
      new Date().toISOString(),
    content: threadContent(thread),
    media,
    detailType: "post",
    url: threadUrl(tid),
    repliesCount: numberOrUndefined(thread.reply_num),
  };
  return { type: "post", post };
}

function mapThreadDetail(
  floor: ThreadFloor,
  tid: string,
  context: PluginInvocationContextV1,
): PostV1 {
  const title = floor.title
    ? "<b>" + escapeHtml(floor.title) + "</b><br/>"
    : "";
  return {
    key: { id: "t" + tid, host: accountHost(context) },
    author: floorAuthor(floor, context),
    createdAt: parseTiebaTime(floor.timeText) ?? new Date().toISOString(),
    content: { format: "html", value: title + floor.contentHtml || " " },
    media: floorMedia(floor),
    detailType: "post",
    url: threadUrl(tid),
  };
}

function mapFloor(
  floor: ThreadFloor,
  tid: string,
  context: PluginInvocationContextV1,
  internal: boolean,
): PostV1 {
  return {
    key: { id: "p" + tid + "_" + floor.pid, host: accountHost(context) },
    author: floorAuthor(floor, context),
    createdAt: parseTiebaTime(floor.timeText) ?? new Date().toISOString(),
    content: { format: "html", value: floor.contentHtml || " " },
    media: floorMedia(floor),
    detailType: internal ? "post" : "link",
    url: threadUrl(tid) + "?pid=" + encodeURIComponent(floor.pid),
  };
}

function threadContent(thread: JsonObject): RichTextV1 {
  const title = text(thread.title).trim();
  const summary = text(thread.abstract).trim();
  const parts: string[] = [];
  if (title) parts.push("<b>" + escapeHtml(title) + "</b>");
  if (summary) parts.push(escapeHtml(summary).replace(/\n/g, "<br/>"));
  return { format: "html", value: parts.join("<br/>") || " " };
}

function mapThreadMedia(thread: JsonObject, tid: string): MediaV1[] | undefined {
  const list = Array.isArray(thread.media) ? thread.media : [];
  const media: MediaV1[] = [];
  for (const value of list) {
    const item = asObject(value);
    if (!item || text(item.type) !== "pic") continue;
    const url =
      text(item.static_img) ||
      text(item.water_pic) ||
      text(item.big_pic) ||
      text(item.src_pic);
    if (!url) continue;
    const preview = text(item.small_pic) || text(item.water_pic);
    media.push({
      id: tid + "-m" + String(media.length),
      type: "image",
      url: normalizeUrl(url),
      previewUrl: preview ? normalizeUrl(preview) : undefined,
    });
    if (media.length >= 9) break;
  }
  return media.length ? media : undefined;
}

function mapUser(
  value: unknown,
  context: PluginInvocationContextV1,
): ProfileV1 | undefined {
  const user = asObject(value);
  if (!user) return undefined;
  const name = text(user.name).trim();
  const id = text(user.id).trim() || name;
  if (!id) return undefined;
  return {
    key: { id, host: accountHost(context) },
    handle: name || id,
    displayName: text(user.name_show).trim() || name || id,
    avatarUrl: avatarUrl(text(user.portrait)),
  };
}

function floorAuthor(
  floor: ThreadFloor,
  context: PluginInvocationContextV1,
): ProfileV1 {
  const id = floor.userName || floor.pid;
  return {
    key: { id, host: accountHost(context) },
    handle: floor.userName || id,
    displayName: floor.displayName || floor.userName || id,
    avatarUrl: avatarUrl(floor.portrait),
  };
}

function floorMedia(floor: ThreadFloor): MediaV1[] | undefined {
  const urls: string[] = [];
  const pattern = /<img\b[^>]*\bsrc=["']([^"']+)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(floor.contentHtml)) !== null) {
    const url = normalizeUrl(decodeEntities(match[1]));
    if (!/^https:\/\/[^/]+\.(?:baidu|bdimg|bdstatic)\.com\//i.test(url)) continue;
    if (/\/tb\/editor\//i.test(url)) continue;
    if (!urls.includes(url)) urls.push(url);
    if (urls.length >= 9) break;
  }
  return urls.length
    ? urls.map((url, index) => ({
        id: floor.pid + "-" + String(index),
        type: "image" as const,
        url,
      }))
    : undefined;
}

function forumDescriptors(value: unknown): TimelineDescriptorV1[] {
  const list = Array.isArray(value) ? value : [];
  const seen = new Set<string>();
  const descriptors: TimelineDescriptorV1[] = [];
  for (const entry of list) {
    const forum = asObject(entry);
    if (!forum) continue;
    const name = text(forum.forum_name).trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    descriptors.push({
      id: "forum:" + name,
      title: { value: name },
      icon: "List",
      parameters: { kw: name },
    });
  }
  return descriptors;
}

function parseThreadPage(html: string): ThreadFloor[] {
  const floors: ThreadFloor[] = [];
  const pattern = /<li\b([^>]*\bj_post_list_item\b[^>]*)>([\s\S]*?)<\/li>/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    const attributes = match[1];
    const body = match[2];
    const rawInfo = /\bdata-info="([^"]*)"/.exec(attributes);
    if (!rawInfo) continue;
    let info: JsonObject;
    try {
      const parsed: unknown = JSON.parse(decodeEntities(rawInfo[1]));
      const object = asObject(parsed);
      if (!object) continue;
      info = object;
    } catch {
      continue;
    }
    const pid = text(info.pid).trim();
    if (!pid) continue;
    const tidMatch = /\bdata-tid="(\d+)"/.exec(attributes);
    const contentMatch = /<div class="content"[^>]*>([\s\S]*?)<\/div>/.exec(body);
    const titleMatch = /<div class="post_title_embed">([\s\S]*?)<\/div>/.exec(body);
    const timeMatch = /<span class="list_item_time">([^<]*)<\/span>/.exec(body);
    floors.push({
      tid: tidMatch ? tidMatch[1] : "",
      pid,
      floor: numberOr(info.floor_num, 1),
      userName: text(info.un).trim(),
      displayName: text(info.name_show).trim(),
      portrait: text(info.portrait).trim(),
      contentHtml: contentMatch ? normalizeContentHtml(contentMatch[1]) : "",
      title: titleMatch ? stripTags(titleMatch[1]).trim() : "",
      timeText: timeMatch ? timeMatch[1].trim() : "",
    });
  }
  return floors;
}

function normalizeContentHtml(html: string): string {
  let out = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "");
  out = out
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son\w+\s*=\s*'[^']*'/gi, "");
  out = out.replace(/https?:\/\/[^"'\s<>]+/gi, (url) => normalizeUrl(url));
  return out.trim();
}

function normalizeUrl(value: string): string {
  let url = decodeEntities(value).trim();
  if (url.startsWith("//")) url = "https:" + url;
  url = url.replace(/^http:\/\//i, "https://");
  url = url.replace(
    /^https:\/\/[a-z0-9-]+\.hiphotos\.baidu\.com\//i,
    "https://imgsrc.baidu.com/",
  );
  url = url.replace(/^https:\/\/tb\.himg\.baidu\.com\//i, "https://himg.bdimg.com/");
  return url;
}

function avatarUrl(portrait: string): string | undefined {
  const value = portrait.trim();
  if (!value) return undefined;
  if (/^https?:\/\//i.test(value)) return normalizeUrl(value);
  return "https://himg.bdimg.com/sys/portrait/item/" + value;
}

function threadUrl(tid: string): string {
  return "https://tieba.baidu.com/p/" + tid;
}

function threadPagePath(tid: string, page: number): string {
  return "/mo/q/m?kz=" + tid + "&pn=" + String(page);
}

function threadIdOf(id: string): string | null {
  if (id.startsWith("t")) {
    const tid = id.slice(1);
    return /^\d+$/.test(tid) ? tid : null;
  }
  const match = /^p(\d+)_\d+$/.exec(id);
  return match ? match[1] : null;
}

async function requestData(
  path: string,
  context: PluginInvocationContextV1,
): Promise<JsonObject> {
  const cookies = await readCookies();
  const response = await hostRequest({
    url: context.origin + path,
    cookies,
    headers: JSON_HEADERS,
  });
  if (response.status === 403) {
    fail("Remote", "百度安全验证拦截了请求，请重新登录");
  }
  if (response.status < 200 || response.status >= 300) {
    fail("Remote", "The website returned an error");
  }
  const root = parseJsonObject(response.body);
  if (!root) fail("InvalidResponse", "The website did not return JSON");
  const code = root.no ?? root.errno;
  if (code !== undefined && Number(code) !== 0) {
    const message = text(root.error) || text(root.errmsg);
    if (/logined|登录/i.test(message)) {
      fail("AuthenticationRequired", "Sign in again");
    }
    fail("Remote", message || "The website rejected the request");
  }
  const data = asObject(root.data);
  if (!data) fail("InvalidResponse", "The website response was incomplete");
  return data;
}

async function requestHtml(
  path: string,
  context: PluginInvocationContextV1,
): Promise<string> {
  const cookies = await readCookies();
  const response = await hostRequest({
    url: context.origin + path,
    cookies,
  });
  if (response.status === 403) {
    fail("Remote", "百度安全验证拦截了请求，请重新登录");
  }
  if (response.status < 200 || response.status >= 300) {
    fail("Remote", "The website returned an error");
  }
  return response.body;
}

async function readCookies(): Promise<TiebaCookie[]> {
  const value = await flare.credential.read();
  const stored = asObject(value);
  const list = stored && Array.isArray(stored.cookies) ? stored.cookies : [];
  const cookies: TiebaCookie[] = [];
  for (const entry of list) {
    const cookie = asObject(entry);
    if (!cookie) continue;
    const name = text(cookie.name);
    const content = text(cookie.value);
    if (name && content) cookies.push({ name, value: content });
  }
  if (!hasCookie(cookies, "BDUSS")) {
    fail("AuthenticationRequired", "Sign in again");
  }
  return cookies;
}

async function hostRequest(request: HttpRequestV1): Promise<HttpResponseV1> {
  try {
    return await flare.http.request(request);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) {
      const code = (error as { code?: unknown }).code;
      if (code === "host.unavailable") {
        fail("Network", "The request could not be completed");
      }
    }
    throw error;
  }
}

function parseJsonObject(body: string): JsonObject | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    return asObject(parsed);
  } catch {
    return undefined;
  }
}

function hasCookie(cookies: TiebaCookie[], name: string): boolean {
  return cookies.some((cookie) => cookie.name === name && cookie.value.length > 0);
}

function isLoggedIn(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}

function asObject(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return "";
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

function numberOr(value: unknown, fallback: number): number {
  return numberOrUndefined(value) ?? fallback;
}

function parsePositiveInt(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function isoFromEpoch(value: unknown): string | undefined {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value)
        ? Number(value)
        : NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return new Date(parsed * 1000).toISOString();
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

function accountHost(context: PluginInvocationContextV1): string {
  return context.origin.slice("https://".length);
}

function fail(code: PluginErrorCodeV1, message: string): never {
  throw flare.error({ code, message: { value: message } });
}
