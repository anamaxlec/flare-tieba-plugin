"use strict";
(() => {
  // src/plugin.ts
  var TIMELINE_CAPABILITY = "flare.datasource.timeline/v1";
  var TAB_CATALOG_CAPABILITY = "flare.datasource.tab-catalog/v1";
  var POST_CAPABILITY = "flare.datasource.post/v1";
  var THREADS_PER_PAGE = 30;
  var MAX_THREAD_PAGES = 20;
  var JSON_HEADERS = {
    Accept: "application/json, text/plain, */*",
    "X-Requested-With": "com.baidu.tieba"
  };
  defineFlareSocialPlugin({
    login: {
      browser: {
        async begin(_request, context) {
          return { type: "webCookie", startUrl: context.origin + "/" };
        },
        async check(request, context) {
          const probeUrl = context.origin + "/mo/q/newmoindex?need_user=1";
          const cookies = request.cookies.cookies.filter((cookie) => cookie.sourceUrl === probeUrl).map(({ name, value }) => ({ name, value }));
          if (!hasCookie(cookies, "BDUSS") || !hasCookie(cookies, "BAIDUID")) {
            return { type: "pending" };
          }
          const response = await hostRequest({
            url: probeUrl,
            cookies,
            headers: JSON_HEADERS
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
                avatarUrl: avatarUrl(text(data.portrait_url))
              },
              capabilities: {
                [TIMELINE_CAPABILITY]: ["page"],
                [TAB_CATALOG_CAPABILITY]: ["page"],
                [POST_CAPABILITY]: ["detail", "context"]
              }
            }
          };
        }
      }
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
        }
      },
      tabCatalog: {
        async page(_request, context) {
          const data = await requestData(
            "/mg/o/getForumHome?st=0&pn=0&rn=50&eqid=&refer=",
            context
          );
          const sections = [];
          const liked = forumDescriptors(asObject(data.like_forum)?.list);
          if (liked.length) {
            sections.push({
              id: "liked",
              title: { value: "\u6211\u5173\u6CE8\u7684\u5427" },
              timelines: { items: liked, endReached: true }
            });
          }
          const recommended = forumDescriptors(data.recomm_forum);
          if (recommended.length) {
            sections.push({
              id: "recommended",
              title: { value: "\u63A8\u8350\u5427" },
              timelines: { items: recommended, endReached: true }
            });
          }
          return { items: sections, endReached: true };
        }
      },
      post: {
        async detail(request, context) {
          const id = request.key.id;
          const tid = threadIdOf(id);
          if (!tid) fail("NotFound", "The requested thread does not exist");
          if (id.startsWith("p")) {
            const pid = id.slice(id.indexOf("_") + 1);
            for (let page = 1; page <= 4; page += 1) {
              const floors2 = parseThreadPage(
                await requestHtml(threadPagePath(tid, page), context)
              );
              const floor = floors2.find((item) => item.pid === pid);
              if (floor) return { post: mapFloor(floor, tid, context, true) };
              if (!floors2.length) break;
            }
            fail("NotFound", "The requested reply does not exist");
          }
          const floors = parseThreadPage(
            await requestHtml(threadPagePath(tid, 1), context)
          );
          const first = floors[0];
          if (!first) fail("NotFound", "The requested thread does not exist");
          return { post: mapThreadDetail(first, tid, context) };
        },
        async context(request, context) {
          const tid = threadIdOf(request.key.id);
          if (!tid) fail("NotFound", "The requested thread does not exist");
          const page = request.page.direction === "refresh" ? 1 : parsePositiveInt(request.page.cursor);
          if (page === null || page > MAX_THREAD_PAGES) {
            fail("Validation", "Invalid page cursor");
          }
          const floors = parseThreadPage(
            await requestHtml(threadPagePath(tid, page), context)
          );
          if (!floors.length) return { items: [], endReached: true };
          const visible = page === 1 ? floors.slice(1) : floors;
          const items = visible.slice(0, request.page.limit).map((floor) => ({
            type: "post",
            post: mapFloor(floor, tid, context, false)
          }));
          return {
            items,
            olderCursor: String(page + 1),
            endReached: false
          };
        }
      }
    }
  });
  async function loadHot(page, context) {
    if (page.direction !== "refresh") return { items: [], endReached: true };
    const data = await requestData("/mo/q/hotMessage/list?fr=newwise", context);
    const list = asObject(data.list);
    const entries = list && Array.isArray(list.ret) ? list.ret : [];
    const items = [];
    for (const entry of entries) {
      const item = mapHotTopic(entry);
      if (item) items.push(item);
      if (items.length >= page.limit) break;
    }
    return { items, endReached: true };
  }
  async function loadForum(forum, page, context) {
    const start = page.direction === "refresh" ? 0 : parsePositiveInt(page.cursor);
    if (start === null || page.cursor === void 0 || page.cursor === "") {
      if (page.direction !== "refresh") fail("Validation", "Invalid page cursor");
    }
    const offset = start === null ? 0 : start;
    const pageNumber = Math.floor(offset / THREADS_PER_PAGE);
    const offsetInPage = offset % THREADS_PER_PAGE;
    const data = await requestData(
      "/f?kw=" + encodeURIComponent(forum) + "&pn=" + String(pageNumber * THREADS_PER_PAGE) + "&fr=newwise",
      context
    );
    const frs = asObject(data.frs_data);
    if (!frs) fail("InvalidResponse", "The forum response was incomplete");
    const threads = Array.isArray(frs.thread_list) ? frs.thread_list : [];
    if (!threads.length) return { items: [], endReached: true };
    const info = asObject(frs.page) ?? {};
    const currentPage = numberOr(info.current_page, pageNumber + 1);
    const totalPage = numberOr(info.total_page, currentPage);
    const slice = threads.slice(offsetInPage, offsetInPage + page.limit);
    const items = [];
    for (const thread of slice) {
      const item = mapThread(thread, context);
      if (item) items.push(item);
    }
    const nextOffset = offset + slice.length;
    const endReached = currentPage >= totalPage && offsetInPage + slice.length >= threads.length;
    return {
      items,
      olderCursor: endReached || !slice.length ? void 0 : String(nextOffset),
      endReached
    };
  }
  function mapHotTopic(value) {
    const entry = asObject(value);
    if (!entry) return void 0;
    const id = text(entry.re_id).trim();
    const title = text(entry.mul_name).trim();
    if (!id || !title) return void 0;
    const info = asObject(entry.topic_info) ?? {};
    const createdAt = isoFromEpoch(entry.create_time) ?? (/* @__PURE__ */ new Date()).toISOString();
    const picture = text(info.head_pic);
    return {
      type: "feed",
      feed: {
        url: "https://tieba.baidu.com/mo/q/hotMessage?topic_id=" + encodeURIComponent(id) + "&topic_name=" + encodeURIComponent(title),
        createdAt,
        source: { name: "\u8D34\u5427\u70ED\u8BAE" },
        title,
        description: {
          format: "plain",
          value: text(entry.share_sub_title) || text(info.topic_desc)
        },
        media: picture ? { id: "hot-" + id, type: "image", url: normalizeUrl(picture) } : void 0
      }
    };
  }
  function mapThread(value, context) {
    const thread = asObject(value);
    if (!thread) return void 0;
    const tid = text(thread.tid) || text(thread.id);
    if (!/^\d+$/.test(tid)) return void 0;
    const media = mapThreadMedia(thread, tid);
    const post = {
      key: { id: "t" + tid, host: accountHost(context) },
      author: mapUser(thread.author, context),
      createdAt: isoFromEpoch(thread.create_time) ?? isoFromEpoch(thread.last_time_int) ?? (/* @__PURE__ */ new Date()).toISOString(),
      content: threadContent(thread),
      media,
      detailType: "post",
      url: threadUrl(tid),
      repliesCount: numberOrUndefined(thread.reply_num)
    };
    return { type: "post", post };
  }
  function mapThreadDetail(floor, tid, context) {
    const title = floor.title ? "<b>" + escapeHtml(floor.title) + "</b><br/>" : "";
    return {
      key: { id: "t" + tid, host: accountHost(context) },
      author: floorAuthor(floor, context),
      createdAt: parseTiebaTime(floor.timeText) ?? (/* @__PURE__ */ new Date()).toISOString(),
      content: { format: "html", value: title + floor.contentHtml || " " },
      media: floorMedia(floor),
      detailType: "post",
      url: threadUrl(tid)
    };
  }
  function mapFloor(floor, tid, context, internal) {
    return {
      key: { id: "p" + tid + "_" + floor.pid, host: accountHost(context) },
      author: floorAuthor(floor, context),
      createdAt: parseTiebaTime(floor.timeText) ?? (/* @__PURE__ */ new Date()).toISOString(),
      content: { format: "html", value: floor.contentHtml || " " },
      media: floorMedia(floor),
      detailType: internal ? "post" : "link",
      url: threadUrl(tid) + "?pid=" + encodeURIComponent(floor.pid)
    };
  }
  function threadContent(thread) {
    const title = text(thread.title).trim();
    const summary = text(thread.abstract).trim();
    const parts = [];
    if (title) parts.push("<b>" + escapeHtml(title) + "</b>");
    if (summary) parts.push(escapeHtml(summary).replace(/\n/g, "<br/>"));
    return { format: "html", value: parts.join("<br/>") || " " };
  }
  function mapThreadMedia(thread, tid) {
    const list = Array.isArray(thread.media) ? thread.media : [];
    const media = [];
    for (const value of list) {
      const item = asObject(value);
      if (!item || text(item.type) !== "pic") continue;
      const url = text(item.static_img) || text(item.water_pic) || text(item.big_pic) || text(item.src_pic);
      if (!url) continue;
      const preview = text(item.small_pic) || text(item.water_pic);
      media.push({
        id: tid + "-m" + String(media.length),
        type: "image",
        url: normalizeUrl(url),
        previewUrl: preview ? normalizeUrl(preview) : void 0
      });
      if (media.length >= 9) break;
    }
    return media.length ? media : void 0;
  }
  function mapUser(value, context) {
    const user = asObject(value);
    if (!user) return void 0;
    const name = text(user.name).trim();
    const id = text(user.id).trim() || name;
    if (!id) return void 0;
    return {
      key: { id, host: accountHost(context) },
      handle: name || id,
      displayName: text(user.name_show).trim() || name || id,
      avatarUrl: avatarUrl(text(user.portrait))
    };
  }
  function floorAuthor(floor, context) {
    const id = floor.userName || floor.pid;
    return {
      key: { id, host: accountHost(context) },
      handle: floor.userName || id,
      displayName: floor.displayName || floor.userName || id,
      avatarUrl: avatarUrl(floor.portrait)
    };
  }
  function floorMedia(floor) {
    const urls = [];
    const pattern = /<img\b[^>]*\bsrc=["']([^"']+)["']/gi;
    let match;
    while ((match = pattern.exec(floor.contentHtml)) !== null) {
      const url = normalizeUrl(decodeEntities(match[1]));
      if (!/^https:\/\/[^/]+\.(?:baidu|bdimg|bdstatic)\.com\//i.test(url)) continue;
      if (/\/tb\/editor\//i.test(url)) continue;
      if (!urls.includes(url)) urls.push(url);
      if (urls.length >= 9) break;
    }
    return urls.length ? urls.map((url, index) => ({
      id: floor.pid + "-" + String(index),
      type: "image",
      url
    })) : void 0;
  }
  function forumDescriptors(value) {
    const list = Array.isArray(value) ? value : [];
    const seen = /* @__PURE__ */ new Set();
    const descriptors = [];
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
        parameters: { kw: name }
      });
    }
    return descriptors;
  }
  function parseThreadPage(html) {
    const floors = [];
    const pattern = /<li\b([^>]*\bj_post_list_item\b[^>]*)>([\s\S]*?)<\/li>/g;
    let match;
    while ((match = pattern.exec(html)) !== null) {
      const attributes = match[1];
      const body = match[2];
      const rawInfo = /\bdata-info="([^"]*)"/.exec(attributes);
      if (!rawInfo) continue;
      let info;
      try {
        const parsed = JSON.parse(decodeEntities(rawInfo[1]));
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
        timeText: timeMatch ? timeMatch[1].trim() : ""
      });
    }
    return floors;
  }
  function normalizeContentHtml(html) {
    let out = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "");
    out = out.replace(/\son\w+\s*=\s*"[^"]*"/gi, "").replace(/\son\w+\s*=\s*'[^']*'/gi, "");
    out = out.replace(/https?:\/\/[^"'\s<>]+/gi, (url) => normalizeUrl(url));
    return out.trim();
  }
  function normalizeUrl(value) {
    let url = decodeEntities(value).trim();
    if (url.startsWith("//")) url = "https:" + url;
    url = url.replace(/^http:\/\//i, "https://");
    url = url.replace(
      /^https:\/\/[a-z0-9-]+\.hiphotos\.baidu\.com\//i,
      "https://imgsrc.baidu.com/"
    );
    url = url.replace(/^https:\/\/tb\.himg\.baidu\.com\//i, "https://himg.bdimg.com/");
    return url;
  }
  function avatarUrl(portrait) {
    const value = portrait.trim();
    if (!value) return void 0;
    if (/^https?:\/\//i.test(value)) return normalizeUrl(value);
    return "https://himg.bdimg.com/sys/portrait/item/" + value;
  }
  function threadUrl(tid) {
    return "https://tieba.baidu.com/p/" + tid;
  }
  function threadPagePath(tid, page) {
    return "/mo/q/m?kz=" + tid + "&pn=" + String(page);
  }
  function threadIdOf(id) {
    if (id.startsWith("t")) {
      const tid = id.slice(1);
      return /^\d+$/.test(tid) ? tid : null;
    }
    const match = /^p(\d+)_\d+$/.exec(id);
    return match ? match[1] : null;
  }
  async function requestData(path, context) {
    const cookies = await readCookies();
    const response = await hostRequest({
      url: context.origin + path,
      cookies,
      headers: JSON_HEADERS
    });
    if (response.status === 403) {
      fail("Remote", "\u767E\u5EA6\u5B89\u5168\u9A8C\u8BC1\u62E6\u622A\u4E86\u8BF7\u6C42\uFF0C\u8BF7\u91CD\u65B0\u767B\u5F55");
    }
    if (response.status < 200 || response.status >= 300) {
      fail("Remote", "The website returned an error");
    }
    const root = parseJsonObject(response.body);
    if (!root) fail("InvalidResponse", "The website did not return JSON");
    const code = root.no ?? root.errno;
    if (code !== void 0 && Number(code) !== 0) {
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
  async function requestHtml(path, context) {
    const cookies = await readCookies();
    const response = await hostRequest({
      url: context.origin + path,
      cookies
    });
    if (response.status === 403) {
      fail("Remote", "\u767E\u5EA6\u5B89\u5168\u9A8C\u8BC1\u62E6\u622A\u4E86\u8BF7\u6C42\uFF0C\u8BF7\u91CD\u65B0\u767B\u5F55");
    }
    if (response.status < 200 || response.status >= 300) {
      fail("Remote", "The website returned an error");
    }
    return response.body;
  }
  async function readCookies() {
    const value = await flare.credential.read();
    const stored = asObject(value);
    const list = stored && Array.isArray(stored.cookies) ? stored.cookies : [];
    const cookies = [];
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
  async function hostRequest(request) {
    try {
      return await flare.http.request(request);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error) {
        const code = error.code;
        if (code === "host.unavailable") {
          fail("Network", "The request could not be completed");
        }
      }
      throw error;
    }
  }
  function parseJsonObject(body) {
    try {
      const parsed = JSON.parse(body);
      return asObject(parsed);
    } catch {
      return void 0;
    }
  }
  function hasCookie(cookies, name) {
    return cookies.some((cookie) => cookie.name === name && cookie.value.length > 0);
  }
  function isLoggedIn(value) {
    return value === true || value === 1 || value === "1" || value === "true";
  }
  function asObject(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : void 0;
  }
  function text(value) {
    if (typeof value === "string") return value;
    if (typeof value === "number") return String(value);
    return "";
  }
  function numberOrUndefined(value) {
    const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
    return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : void 0;
  }
  function numberOr(value, fallback) {
    return numberOrUndefined(value) ?? fallback;
  }
  function parsePositiveInt(value) {
    if (!value || !/^\d+$/.test(value)) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }
  function isoFromEpoch(value) {
    const parsed = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
    if (!Number.isFinite(parsed) || parsed <= 0) return void 0;
    return new Date(parsed * 1e3).toISOString();
  }
  function parseTiebaTime(value) {
    const source = value.trim();
    if (!source) return void 0;
    const now = new Date(Date.now() + 8 * 60 * 60 * 1e3);
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
        Number(match[2])
      );
    }
    match = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?$/.exec(source);
    if (match) {
      return isoShanghai(
        Number(match[1]),
        Number(match[2]),
        Number(match[3]),
        Number(match[4] ?? 0),
        Number(match[5] ?? 0)
      );
    }
    match = /^(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?$/.exec(source);
    if (match) {
      return isoShanghai(
        year,
        Number(match[1]),
        Number(match[2]),
        Number(match[3] ?? 0),
        Number(match[4] ?? 0)
      );
    }
    return void 0;
  }
  function isoShanghai(year, month, day, hour, minute) {
    return String(year) + "-" + pad2(month) + "-" + pad2(day) + "T" + pad2(hour) + ":" + pad2(minute) + ":00+08:00";
  }
  function pad2(value) {
    return String(value).padStart(2, "0");
  }
  function decodeEntities(value) {
    return value.replace(/&quot;/g, '"').replace(/&#0*39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
  }
  function escapeHtml(value) {
    return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function stripTags(value) {
    return decodeEntities(value.replace(/<[^>]*>/g, ""));
  }
  function accountHost(context) {
    return context.origin.slice("https://".length);
  }
  function fail(code, message) {
    throw flare.error({ code, message: { value: message } });
  }
})();
