import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

test("hot topics open natively and paginate their related threads", async () => {
  const origin = "https://tieba.baidu.com";
  const context = { scope: "guest", origin, locale: "zh-Hans", credentialAvailable: false };
  const topic = {
    topic_id: 123,
    topic_name: "本周讨论",
    topic_desc: "热点简介",
    topic_pic: "https://tiebapic.baidu.com/topic.jpg",
  };
  const featured = {
    card_type: "common_thread",
    data: {
      thread_info: {
        tid: 21,
        title: "精选讨论",
        author: { name: "吧友", portrait_url: "https://tiebapic.baidu.com/avatar.jpg" },
        abstract: [{ type: 0, text: "帖子摘要" }],
        fname: "数码",
        fid: 9,
        reply_num: 7,
        media: [{ type: 3, src_pic: "https://tiebapic.baidu.com/photo.jpg" }],
      },
    },
  };
  const related = (tid) => ({ card_type: "hot-thread", card_data: { tid, title: "相关讨论" } });
  let plugin;
  runInNewContext(readFileSync(new URL("../plugin.js", import.meta.url), "utf8"), {
    defineFlareSocialPlugin(value) { plugin = value; },
    flare: {
      error: (error) => new Error(error.message.value),
      http: {
        async request({ url }) {
          const { pathname, searchParams } = new URL(url);
          let body;
          if (pathname === "/hottopic/browse/topicList") {
            body = { data: { bang_topic: { topic_list: [topic] } } };
          } else if (pathname === "/mo/q/recommend") {
            body = { data: { hot_thread_list: [featured.data.thread_info] } };
          } else {
            assert.equal(pathname, "/c/f/hottopic/topicDetail");
            assert.equal(searchParams.get("topic_id"), "123");
            assert.equal(searchParams.get("is_share"), "1");
            const secondPage = searchParams.get("pn") === "2";
            assert.equal(searchParams.get("offset"), secondPage ? "15" : "0");
            assert.equal(searchParams.get("last_id"), secondPage ? "22" : "0");
            body = {
              error_code: "0",
              topic_info: secondPage ? undefined : topic,
              area_card_list: [{ card_data: [featured, related(secondPage ? 23 : 22)] }],
              has_more: Number(!secondPage),
            };
          }
          return { status: 200, headers: {}, body: JSON.stringify(body) };
        },
      },
    },
  });

  const { timeline, post } = plugin.capabilities;
  const refresh = { direction: "refresh", limit: 2, parameters: {} };
  const hot = await timeline.page({ timelineId: "hot", page: refresh, parameters: {} }, context);
  const { target } = hot.items[0].feed;
  assert.equal(target.type, "post");
  assert.equal(target.key.id, "hot:123");
  assert.equal(target.key.host, "tieba.baidu.com");

  const detail = await post.detail({ key: target.key }, context);
  assert.equal(detail.post.content.value, "<b>本周讨论</b><br>热点简介");
  assert.equal(detail.post.media[0].url, topic.topic_pic);

  const load = (page) => post.context({ key: target.key, page }, context);
  const loadOlder = (cursor) => load({ ...refresh, direction: "older", cursor });
  const first = await load(refresh);
  assert.deepEqual(Array.from(first.items, ({ post }) => post.key.id), ["hot:123", "21"]);
  const thread = first.items[1].post;
  assert.match(thread.content.value, /帖子摘要/);
  assert.equal(thread.sourceChannel.name, "数码吧");
  assert.equal(thread.repliesCount, 7);
  assert.equal(thread.media[0].url, "https://tiebapic.baidu.com/photo.jpg");

  const remainder = await loadOlder(first.olderCursor);
  assert.deepEqual(Array.from(remainder.items, ({ post }) => post.key.id), ["22"]);
  const second = await loadOlder(remainder.olderCursor);
  assert.deepEqual(Array.from(second.items, ({ post }) => post.key.id), ["23"]);
  assert.equal(second.endReached, true);

  const recommendations = await timeline.page({ timelineId: "recommend", page: refresh, parameters: {} }, context);
  assert.equal(recommendations.items[0].feed.source.iconIsAvatar, true);
  assert.equal(recommendations.items[0].feed.source.iconUrl, "https://tiebapic.baidu.com/avatar.jpg");
});
