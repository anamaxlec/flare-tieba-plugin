"use strict";
(() => {
  // src/plugin.ts
  var TIEBA_HOST = "tieba.baidu.com";
  var TIEBA_ORIGIN = "https://" + TIEBA_HOST;
  var LOGIN_URL = "https://wappass.baidu.com/passport/?login&tpl=tb&u=https%3A%2F%2Ftieba.baidu.com%2Fmo%2Fq%2Ffrs%3Fkw%3D%25E6%2595%25B0%25E7%25A0%2581";
  var ACCOUNT_PATH = "/mo/q/newmoindex?need_user=1";
  var CATALOG_PATH = "/mg/o/getForumHome?st=0&pn=0&rn=50&eqid=&refer=";
  var LANGUAGE = ["zh-CN"];
  var JSON_HEADERS = {
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9",
    Referer: TIEBA_ORIGIN + "/",
    "User-Agent": "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
    "X-Requested-With": "XMLHttpRequest"
  };
  var CAPABILITIES = {
    "flare.datasource.timeline/v1": ["page"],
    "flare.datasource.tab-catalog/v1": ["page"],
    "flare.datasource.post/v1": ["detail", "context"],
    "flare.datasource.search/v1": ["posts", "profiles", "discoverPosts", "discoverProfiles", "discoverHashtags"],
    "flare.datasource.profile/v1": ["byId", "byHandle"]
  };
  defineFlareSocialPlugin({
    detector: {
      detect({ origin }) {
        if (origin.toLowerCase() !== TIEBA_ORIGIN) return { match: "none", canonicalOrigin: origin };
        return {
          match: "exact",
          canonicalOrigin: TIEBA_ORIGIN,
          software: "Baidu Tieba",
          instance: { domain: TIEBA_HOST, title: "\u767E\u5EA6\u8D34\u5427" }
        };
      }
    },
    login: {
      browser: {
        begin() {
          return { type: "webCookie", startUrl: LOGIN_URL };
        },
        async check(request, context) {
          const probe = context.origin + ACCOUNT_PATH;
          const cookies = request.cookies.cookies.filter((cookie) => cookie.sourceUrl === probe && cookie.value).map(({ name, value }) => ({ name, value }));
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
              capabilities: CAPABILITIES
            }
          };
        }
      }
    },
    capabilities: {
      timeline: {
        async page(request, context) {
          const { timelineId, page } = request;
          if (timelineId === "hot") return pageRows(await hotTopics(context), page);
          if (timelineId === "recommend") return loadRecommendations(page, context);
          const forum = text(request.parameters.kw || page.parameters.kw || timelineId.match(/^forum:(.+)$/)?.[1]).trim();
          if (!forum) fail("Unsupported", "\u627E\u4E0D\u5230\u6B64\u65F6\u95F4\u7EBF\u5BF9\u5E94\u7684\u8D34\u5427");
          return loadForum(forum, page, context);
        }
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
          const profiles = /* @__PURE__ */ new Map();
          for (const { post } of items) {
            if (post.author) profiles.set(post.author.key.id, post.author);
          }
          return pageRows([...profiles.values()], page, { batch, skip }, hasMore);
        },
        async discoverHashtags({ page }, context) {
          const topics = await hotTopics(context);
          return pageRows(topics.map(({ feed }) => ({ name: feed.title ?? "", url: feed.url })), page);
        }
      },
      profile: {
        async byId(request, context) {
          const id = request.key.id;
          if (context.accountId === id) {
            const profile = await verifiedAccount(context.origin, await readCookies(context));
            if (profile?.key.id === id) return profile;
            fail("AuthenticationRequired", "\u8D34\u5427\u767B\u5F55\u5DF2\u5931\u6548\uFF0C\u8BF7\u91CD\u65B0\u767B\u5F55");
          }
          return findProfile(id, context);
        },
        async byHandle({ handle }, context) {
          return findProfile(handle, context);
        }
      },
      post: {
        async detail(request, context) {
          const ref = postRef(request.key.id);
          if (!ref) fail("NotFound", "\u627E\u4E0D\u5230\u8FD9\u7BC7\u5E16\u5B50");
          if (ref.pid && ref.parent) {
            const page = await loadSubfloors(ref.tid, ref.parent.pid, ref.offset ?? 0, context);
            const floor = page.floors.find(({ pid }) => pid === ref.pid);
            if (floor) return { post: mapFloor(floor, ref.tid, request.key.id, ref.parent) };
            fail("NotFound", "\u627E\u4E0D\u5230\u8FD9\u6761\u697C\u4E2D\u697C\u56DE\u590D");
          }
          let offset = ref.offset ?? 0;
          for (let attempt = 0; attempt < 4; attempt++) {
            const page = await loadFloors(ref.tid, offset, context);
            const floor = ref.pid ? page.floors.find(({ pid }) => pid === ref.pid) : page.floors.find(({ index }) => index === 1);
            if (floor) {
              const post = mapFloor(floor, ref.tid, request.key.id, void 0, page.forum);
              if (!ref.pid) post.repliesCount = page.repliesCount;
              if (floor.media.some(({ type }) => type === "image" || type === "gif")) {
                const originals = await loadOriginalImages(ref.tid, floor.pid, context).catch(() => []);
                if (originals.length) {
                  post.media = [...originals, ...floor.media.filter(({ type }) => type === "video")];
                }
              }
              return { post };
            }
            if (!ref.pid || ref.offset !== void 0 || page.nextOffset === void 0) break;
            offset = page.nextOffset;
          }
          fail("NotFound", "\u627E\u4E0D\u5230\u8FD9\u6761\u5E16\u5B50\u6216\u56DE\u590D");
        },
        async context(request, context) {
          const ref = postRef(request.key.id);
          if (!ref) fail("NotFound", "\u627E\u4E0D\u5230\u8FD9\u7BC7\u5E16\u5B50");
          if (ref.parent) return { items: [], endReached: true };
          const page = request.page;
          const { batch, skip } = pagePosition(page, 0);
          const parent = ref.pid ? { pid: ref.pid, key: request.key.id, offset: ref.offset ?? 0 } : void 0;
          const loaded = ref.pid ? await loadSubfloors(ref.tid, ref.pid, batch, context) : await loadFloors(ref.tid, batch, context);
          const floors = loaded.floors.filter(({ index }) => ref.pid || index !== 1);
          const items = floors.map((floor) => ({
            type: "post",
            post: mapFloor(floor, ref.tid, replyKey(ref.tid, floor.pid, batch, parent), parent)
          }));
          return pageRows(items, page, { batch, skip }, loaded.nextOffset !== void 0, loaded.nextOffset);
        }
      }
    }
  });
  async function verifiedAccount(origin, cookies) {
    const response = await hostRequest(origin + ACCOUNT_PATH, cookies);
    if ([401, 403].includes(response.status)) return void 0;
    requireStatus(response);
    const data = asObject(parseJsonObject(response.body)?.data);
    if (!data) return void 0;
    const user = asObject(data.user) ?? asObject(data.user_info) ?? data;
    if (!isTrue(data.is_login ?? user.is_login)) return void 0;
    const id = numericId(user.uid || user.id || user.user_id || data.uid);
    if (id && id !== "0") return mapUser(user, id);
    const catalog = await hostRequest(origin + CATALOG_PATH, cookies);
    if (catalog.status !== 200) return void 0;
    const profile = asObject(asObject(parseJsonObject(catalog.body)?.data)?.user_info);
    const catalogId = numericId(profile?.id);
    return isTrue(profile?.is_login) && catalogId && catalogId !== "0" ? mapUser({ ...user, ...profile }, catalogId) : void 0;
  }
  async function loadCatalog(page, context) {
    if (page.direction !== "refresh") return { items: [], endReached: true };
    const data = await requestData(CATALOG_PATH, context);
    const liked = asObject(data.like_forum);
    const seen = /* @__PURE__ */ new Set();
    const sections = [];
    for (const [id, title, forums] of [
      ["liked", { key: "catalog.followed", fallback: "Followed forums" }, asArray(liked?.list ?? data.like_forum)],
      ["recommended", { key: "catalog.recommended", fallback: "Recommended forums" }, asArray(data.recomm_forum)]
    ]) {
      const items = [];
      for (const value of forums) {
        const forum = asObject(value);
        const name = text(forum?.forum_name ?? forum?.name).trim();
        if (!name || seen.has(name)) continue;
        seen.add(name);
        items.push({ id: "forum:" + name, title: { value: name + "\u5427" }, icon: "List", parameters: { kw: name } });
      }
      if (items.length) sections.push({ id, title, timelines: { items, endReached: true } });
    }
    return { items: sections, endReached: true };
  }
  async function hotTopics(context) {
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
          source: { name: "\u8D34\u5427\u70ED\u8BAE" },
          description: summary ? { format: "plain", value: summary } : void 0,
          media: picture ? { id: "hot-" + id, type: "image", url: picture } : void 0,
          sourceLanguages: LANGUAGE
        }
      }];
    });
  }
  async function recommendedPosts(batch, context) {
    const data = await requestData("/mo/q/recommend?pn=" + batch, context);
    const rows = [...asArray(data.hot_thread_list), ...asArray(data.video_thread_list)];
    return { items: mapThreads(rows), hasMore: rows.length > 0 };
  }
  async function loadRecommendations(page, context) {
    const position = pagePosition(page);
    const { items, hasMore } = await recommendedPosts(position.batch, context);
    return pageRows(items, page, position, hasMore);
  }
  async function loadForum(forum, page, context) {
    const position = pagePosition(page, 0);
    const path = "/mo/q/frs?kw=" + encodeURIComponent(forum) + "&pn=" + position.batch;
    const response = await requestSite(path, context, true);
    const html = response.body;
    const list = inlineJson(html, /\bthread_list:\s*(?=\[)/);
    if (!Array.isArray(list)) {
      if (/本吧暂不开放|该吧不存在|此吧不存在/.test(html)) fail("NotFound", "\u8FD9\u4E2A\u8D34\u5427\u6682\u4E0D\u53EF\u7528");
      fail("InvalidResponse", "\u8D34\u5427\u6CA1\u6709\u8FD4\u56DE\u5E16\u5B50\u5217\u8868");
    }
    const info = asObject(inlineJson(html, /\bpage:\s*(?=\{"req_num":)/));
    const size = positiveInt(info?.page_size) ?? 30;
    const offset = numberOrUndefined(info?.offset) ?? position.batch;
    const next = offset + size;
    const hasMore = list.length > 0 && next < (positiveInt(info?.total_page) ?? 1) * size && next > position.batch;
    return pageRows(mapThreads(list, forum), page, position, hasMore, next);
  }
  async function loadPostSearch({ query, page }, context) {
    const word = query.trim();
    if (!word) return { items: [], endReached: true };
    const position = pagePosition(page);
    const suffix = "?word=" + encodeURIComponent(word) + "&pn=" + position.batch;
    const data = await requestData("/mo/q/search/thread" + suffix, context);
    const posts = mapThreads(asArray(data.post_list));
    if (position.batch === 1) {
      const forums = await requestData("/mo/q/search/forum" + suffix, context).catch(() => void 0);
      const forum = asObject(forums?.exactMatch);
      const name = text(forum?.forum_name);
      if (name) {
        const image = httpsUrl(text(forum?.avatar));
        posts.unshift({
          type: "feed",
          feed: {
            url: TIEBA_ORIGIN + "/mo/q/frs?kw=" + encodeURIComponent(name),
            title: name + "\u5427",
            description: { format: "plain", value: text(forum?.intro ?? forum?.slogan) },
            createdAt: postTime(),
            source: { name: "\u767E\u5EA6\u8D34\u5427" },
            media: image ? { id: "forum-" + name, type: "image", url: image } : void 0,
            sourceLanguages: LANGUAGE
          }
        });
      }
    }
    return pageRows(posts, page, position, isTrue(data.has_more));
  }
  async function searchUsers(query, batch, context) {
    const data = await requestData("/mo/q/search/user?word=" + encodeURIComponent(query) + "&pn=" + batch, context);
    const unique = /* @__PURE__ */ new Map();
    for (const value of [data.exactMatch, ...asArray(data.fuzzyMatch)]) {
      const user = mapUser(value);
      if (user) unique.set(user.key.id, user);
    }
    return { users: [...unique.values()], hasMore: isTrue(data.has_more) };
  }
  async function findProfile(handle, context) {
    const { users } = await searchUsers(handle, 1, context);
    const profile = users.find((user) => user.key.id === handle || user.handle === handle);
    if (!profile) fail("NotFound", "\u627E\u4E0D\u5230\u8FD9\u4F4D\u5427\u53CB");
    return profile;
  }
  function mapThreads(rows, forum) {
    const posts = /* @__PURE__ */ new Map();
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
        sourceLanguages: LANGUAGE
      });
    }
    return [...posts.values()].map((post) => ({ type: "post", post }));
  }
  function threadMedia(thread, tid) {
    const media = [];
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
        height: positiveInt(item.height)
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
        height: positiveInt(video?.height ?? thread.video_height)
      });
    }
    const picture = httpsUrl(text(thread.pic_url));
    if (!media.length && picture) media.push({ id: tid + "-m0", type: "image", url: picture });
    return media.slice(0, 9);
  }
  function mapUser(value, accountId) {
    const user = asObject(value);
    if (!user) return void 0;
    const name = text(user.user_name ?? user.name ?? user.un).trim();
    const display = text(user.show_nickname || user.name_show || user.name_nickname || user.user_nickname).trim();
    const id = accountId ?? name;
    if (!id) return void 0;
    return {
      key: key(id),
      handle: name || id,
      displayName: display || name || id,
      avatarUrl: avatarUrl(text(user.portrait_url || user.portrait)),
      description: text(user.intro) ? { format: "plain", value: text(user.intro) } : void 0,
      followersCount: numberOrUndefined(user.fans_num),
      url: name ? TIEBA_ORIGIN + "/home/main?un=" + encodeURIComponent(name) : void 0
    };
  }
  async function loadFloors(tid, offset, context) {
    const path = "/mo/q/pb?kz=" + tid + "&pn=" + (offset || 1);
    if (offset === 0) {
      const html = (await requestSite(path, context, true)).body;
      const floors = parseFloors(html);
      if (!floors.length) fail("NotFound", "\u8FD9\u7BC7\u5E16\u5B50\u5DF2\u5220\u9664\u3001\u53D7\u9650\u6216\u6682\u65F6\u65E0\u6CD5\u67E5\u770B");
      const info = asObject(inlineJson(html, /\bpage:\s*(?=\{"req_num":)/));
      const forum = text(inlineJson(html, /\bforum_name:\s*(?=")/));
      const thread = asObject(inlineJson(html, /\bthreadInfo:\s*(?=\{)/));
      return { floors, nextOffset: nextFloorOffset(info, offset), forum, repliesCount: numberOrUndefined(thread?.reply_num) };
    }
    const data = await requestData(path + "&is_ajax=1", context);
    return { floors: parseFloors(text(data.html)), nextOffset: nextFloorOffset(asObject(data.page), offset), forum: "", repliesCount: void 0 };
  }
  async function loadSubfloors(tid, parent, offset, context) {
    const data = await requestData("/mo/q/flr?kz=" + tid + "&pid=" + parent + "&pnum=" + (offset || 1), context);
    const info = asObject(data.page);
    const current = positiveInt(info?.current_page) ?? 1;
    const total = positiveInt(info?.total_page) ?? 1;
    return {
      floors: parseFloors(text(data.floor_html), true),
      nextOffset: current < total && current + 1 > offset ? current + 1 : void 0
    };
  }
  async function loadOriginalImages(tid, pid, context) {
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
        type: /\.gif(?:[?#]|$)/i.test(url) ? "gif" : "image",
        url,
        previewUrl: httpsUrl(text(asObject(image?.medium)?.url)),
        width: positiveInt(original?.width),
        height: positiveInt(original?.height)
      }];
    }).slice(0, 9);
  }
  function nextFloorOffset(page, requested) {
    const current = positiveInt(page?.current_page) ?? 1;
    const total = positiveInt(page?.total_page) ?? 1;
    const next = current * (positiveInt(page?.page_size) ?? 30);
    return current < total && next > requested ? next : void 0;
  }
  function parseFloors(html, nested = false) {
    const className = nested ? "j_list_item_floor" : "j_post_list_item";
    const starts = [...html.matchAll(/<li\b[^>]*>/gi)].filter((match) => attribute(match[0], "class").split(/\s+/).includes(className));
    const floors = [];
    for (const [index, start] of starts.entries()) {
      const body = html.slice(start.index + start[0].length, starts[index + 1]?.index);
      const info = parseJsonObject(attribute(start[0], "data-info"));
      const pid = numericId(info?.pid ?? attribute(start[0], nested ? "pid" : "tid"));
      if (!pid) continue;
      const content = classContent(body, nested ? "span" : "div", nested ? "floor_content" : "content");
      const media = floorMedia(content, pid);
      const author = mapUser({
        name: info?.un,
        name_show: info?.name_show ?? (nested ? stripTags(classContent(body, "a", "user_name")).trim().replace(/[:：]$/, "") : void 0),
        portrait: info?.portrait
      });
      floors.push({
        pid,
        index: positiveInt(info?.floor_num ?? attribute(start[0], "fn")) ?? 0,
        author,
        title: stripTags(classContent(body, "div", "post_title_embed")).trim(),
        content: displayFloorContent(content),
        time: stripTags(classContent(body, "span", "list_item_time")).trim(),
        media,
        repliesCount: nested ? void 0 : numberOrUndefined(attribute(classTag(body, "div", "j_floor_panel")?.[0] ?? "", "data-list-count"))
      });
    }
    return floors;
  }
  function mapFloor(floor, tid, id, parent, forum) {
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
      replyTo: thread ? void 0 : key(parent?.key ?? tid),
      repliesCount: floor.repliesCount,
      sourceChannel: forumChannel(forum ?? ""),
      sourceLanguages: LANGUAGE
    };
  }
  function floorMedia(html, pid) {
    const items = [];
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
        previewUrl: isVideo ? httpsUrl(attribute(tag, "poster")) : void 0,
        description: attribute(tag, "alt") || void 0,
        width: positiveInt(attribute(tag, "width")),
        height: positiveInt(attribute(tag, "height"))
      });
      if (items.length === 9) break;
    }
    return items;
  }
  function displayFloorContent(html) {
    return html.replace(/<(script|style|video)\b[^>]*>[\s\S]*?<\/\1>/gi, "").replace(/<a\b[^>]*\bdata-vhsrc=[^>]*>[\s\S]*?<\/a>/gi, "").replace(/<div\b[^>]*class=["'][^"']*\bj_videoFootDownBtn\b[^"']*["'][^>]*>[\s\S]*?<\/div>/gi, "").replace(/<div\b[^>]*class=["'][^"']*\bpb_less_imgs\b[^"']*["'][^>]*>[\s\S]*$/i, "").replace(/<img\b[^>]*>/gi, (tag) => {
      const src = httpsUrl(attribute(tag, "src"));
      if (src && /\/tb\/editor\//i.test(src)) return '<img src="' + escapeHtml(src) + '" alt="' + escapeHtml(attribute(tag, "alt")) + '">';
      return "";
    }).replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "").replace(/\bhref=(["'])(\/[^/"'][^"']*)\1/gi, (_link, quote, path) => "href=" + quote + TIEBA_ORIGIN + path + quote).trim();
  }
  function classTag(html, tag, name) {
    return [...html.matchAll(new RegExp("<" + tag + "\\b[^>]*>", "gi"))].find((match) => attribute(match[0], "class").split(/\s+/).includes(name));
  }
  function classContent(html, tag, name) {
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
  function attribute(tag, name) {
    const value = new RegExp("(?:^|\\s)" + name + `\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
    return value ? decodeEntities(value[1] ?? value[2] ?? value[3]) : "";
  }
  function inlineJson(html, marker) {
    const match = marker.exec(html);
    if (!match) return void 0;
    const start = match.index + match[0].length;
    const tokens = /"(?:[^"\\]|\\[\s\S])*"|[\[\]{}]/g;
    tokens.lastIndex = start;
    let depth = 0;
    for (let token = tokens.exec(html); token; token = tokens.exec(html)) {
      if (token[0] === "{" || token[0] === "[") depth++;
      if (token[0] === "}" || token[0] === "]") depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, tokens.lastIndex));
        } catch {
          return void 0;
        }
      }
    }
    return void 0;
  }
  function pagePosition(page, first = 1) {
    if (page.direction === "refresh") return { batch: first, skip: 0 };
    const match = /^(\d+)(?::(\d+))?$/.exec(page.cursor ?? "");
    const batch = Number(match?.[1]);
    const skip = Number(match?.[2] ?? 0);
    if (page.direction !== "older" || !Number.isSafeInteger(batch) || !Number.isSafeInteger(skip)) {
      fail("Validation", "\u5206\u9875\u4F4D\u7F6E\u65E0\u6548\uFF0C\u8BF7\u5237\u65B0\u540E\u91CD\u8BD5");
    }
    return { batch, skip };
  }
  function pageRows(rows, page, position = pagePosition(page), hasMore = false, nextBatch = position.batch + 1) {
    const items = rows.slice(position.skip, position.skip + page.limit);
    const end = position.skip + items.length;
    const olderCursor = end < rows.length ? position.batch + ":" + end : hasMore ? String(nextBatch) : void 0;
    return { items, olderCursor, endReached: olderCursor === void 0 };
  }
  function postRef(id) {
    const thread = /^t?(\d+)$/.exec(id);
    if (thread) return { tid: thread[1] };
    const reply = /^p(\d+)_(\d+)(?:_(\d+)(?:_(\d+)_(\d+))?)?$/.exec(id);
    if (!reply) return void 0;
    const [, tid, pid, offset, parent, parentOffset] = reply;
    const parentPage = Number(parentOffset);
    return {
      tid,
      pid,
      offset: numberOrUndefined(offset),
      parent: parent ? { pid: parent, offset: parentPage, key: replyKey(tid, parent, parentPage) } : void 0
    };
  }
  function replyKey(tid, pid, offset, parent) {
    return "p" + tid + "_" + pid + "_" + offset + (parent ? "_" + parent.pid + "_" + parent.offset : "");
  }
  function key(id) {
    return { id, host: TIEBA_HOST };
  }
  function threadUrl(tid) {
    return TIEBA_ORIGIN + "/p/" + tid;
  }
  function forumChannel(name, id) {
    return name ? { id: numericId(id) ?? name, name: name + "\u5427" } : void 0;
  }
  function httpsUrl(value) {
    const url = decodeEntities(value).trim().replace(/^\/\//, "https://").replace(/^http:\/\//i, "https://").replace(/^https:\/\/[a-z0-9-]+\.hiphotos\.baidu\.com\//i, "https://imgsrc.baidu.com/").replace(/^https:\/\/tb\.himg\.baidu\.com\//i, "https://himg.bdimg.com/");
    return /^https:\/\/[a-z0-9.-]+(?::\d+)?(?:[/?#]|$)/i.test(url) && !/[\s<>"']/.test(url) ? url : void 0;
  }
  function avatarUrl(portrait) {
    return httpsUrl(portrait) ?? (/^[\w.-]+(?:\?t=\d+)?$/.test(portrait) ? "https://himg.bdimg.com/sys/portrait/item/" + portrait : void 0);
  }
  async function requestSite(path, context, html = false) {
    const response = await hostRequest(context.origin + path, await readCookies(context), html);
    requireStatus(response);
    return response;
  }
  async function requestData(path, context) {
    const response = await requestSite(path, context);
    const root = parseJsonObject(response.body);
    if (!root) fail("InvalidResponse", "\u8D34\u5427\u8FD4\u56DE\u4E86\u65E0\u6CD5\u8BFB\u53D6\u7684\u9875\u9762");
    const code = root.no ?? root.errno;
    if (code !== void 0 && Number(code) !== 0) {
      const message = text(root.error || root.errmsg);
      if (/not logined|未登录|没有登录|请登录/i.test(message)) fail("AuthenticationRequired", "\u8BF7\u767B\u5F55\u8D34\u5427\u540E\u91CD\u8BD5");
      fail("Remote", message || "\u8D34\u5427\u63A5\u53E3\u6682\u4E0D\u53EF\u7528");
    }
    const data = asObject(root.data);
    if (!data) fail("InvalidResponse", "\u8D34\u5427\u8FD4\u56DE\u7684\u6570\u636E\u4E0D\u5B8C\u6574");
    return data;
  }
  async function readCookies(context) {
    if (context.scope !== "account" || !context.credentialAvailable) return [];
    const credential = asObject(await flare.credential.read());
    return asArray(credential?.cookies).flatMap((entry) => {
      const cookie = asObject(entry);
      const name = text(cookie?.name);
      const value = text(cookie?.value);
      return name && value ? [{ name, value }] : [];
    });
  }
  async function hostRequest(url, cookies, html = false) {
    try {
      return await flare.http.request({
        url,
        cookies,
        headers: html ? { ...JSON_HEADERS, Accept: "text/html,application/xhtml+xml,*/*;q=0.8" } : JSON_HEADERS
      });
    } catch (error) {
      if (asObject(error)?.code === "host.unavailable") fail("Network", "\u6682\u65F6\u65E0\u6CD5\u8FDE\u63A5\u8D34\u5427");
      throw error;
    }
  }
  function requireStatus(response) {
    if (response.status === 401) fail("AuthenticationRequired", "\u8BF7\u91CD\u65B0\u767B\u5F55\u8D34\u5427");
    if (response.status === 403) fail("Remote", "\u767E\u5EA6\u5B89\u5168\u9A8C\u8BC1\u62E6\u622A\u4E86\u8BF7\u6C42\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5");
    if (response.status === 404) fail("NotFound", "\u8D34\u5427\u9875\u9762\u4E0D\u5B58\u5728");
    if (response.status === 429) fail("RateLimited", "\u8D34\u5427\u8BF7\u6C42\u8FC7\u4E8E\u9891\u7E41\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5");
    if (response.status < 200 || response.status >= 300) fail("Remote", "\u8D34\u5427\u6682\u65F6\u65E0\u6CD5\u8FD4\u56DE\u6570\u636E");
  }
  function parseJsonObject(body) {
    try {
      return asObject(JSON.parse(body));
    } catch {
      return void 0;
    }
  }
  function asObject(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : void 0;
  }
  function asArray(value) {
    return Array.isArray(value) ? value : [];
  }
  function text(value) {
    if (typeof value === "string") return value;
    return typeof value === "number" ? String(value) : "";
  }
  function numericId(value) {
    if (typeof value === "number" && !Number.isSafeInteger(value)) return void 0;
    const id = text(value);
    return /^\d+$/.test(id) ? id : void 0;
  }
  function positiveInt(value) {
    const number = numberOrUndefined(value);
    return number && number > 0 ? number : void 0;
  }
  function isTrue(value) {
    return value === true || value === 1 || value === "1" || value === "true";
  }
  function postTime(value) {
    return isoFromEpoch(value) ?? (/* @__PURE__ */ new Date()).toISOString();
  }
  function numberOrUndefined(value) {
    const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
    return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : void 0;
  }
  function isoFromEpoch(value) {
    const parsed = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
    const date = new Date(parsed * 1e3);
    return parsed > 0 && Number.isFinite(date.getTime()) ? date.toISOString() : void 0;
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
  function fail(code, message) {
    throw flare.error({ code, message: { value: message } });
  }
})();
