const CONFIG = {
  // 必填：你的机器人用户名 (不带 @ 符号)
  bot_username: "YOUR_BOT_USERNAME", 

  // 验证成功后自动删除消息的延迟秒数
  auto_delete_success_msg_sec: 3,

  group_start_msg: "我还活着，不用你费心了。",
  group_help_msg: "想要帮助请转到私聊。",
  group_help_btn: "点击转到私聊",

  private_start_msg: "欧嗨哟！如果你需要就把我放在群聊吧，我可是很强的。如有问题请联系我的创作者。",
  private_help_msg: "需要帮助吗?你需要将我设置成群聊管理员，给我必要的权限，否则我会失去作用的。可以让所有人开启新成员入群需审批，我就会将私聊对方审核。如有问题请联系我的创作者。",
  private_help_btn: "点击一键添加我为管理员",

  direct_join_msg: "欢迎 <b>{name}</b> 加入！\n请点击下方按钮转到私聊完成人机验证，否则将被移除。",
  direct_join_btn: "去私聊验证",

  verify_request_text: "你好！收到你加入群组 <b>{chat_title}</b> 的申请。\n\n为了防止垃圾账号，请点击下方按钮进行安全验证。",
  verify_button_text: "点击进行人机验证",

  page_title: "入群安全验证",
  page_header: "安全检测",
  page_desc: "请完成下方验证",
  page_status_verifying: "正在验证中...",
  page_status_success: "验证通过！正在跳转...",
  page_status_fail: "验证失败或链接已过期",

  verify_pass_group_msg: "{mention} 已通过审核",
  verify_pass_private_msg: "恭喜！验证通过。"
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname.startsWith("/s/")) {
      const token = url.pathname.split("/")[2];
      return handleVerifyPage(token, env);
    }

    if (request.method === "GET" && url.pathname === "/verify") {
      const token = url.searchParams.get("token") || url.searchParams.get("sessionToken");
      if (!token) {
        return new Response("验证链接格式错误：缺少关键验证参数，请回群重新获取。", { 
          status: 400, headers: { "Content-Type": "text/plain;charset=UTF-8" } 
        });
      }
      return handleVerifyPage(token, env);
    }

    if (request.method === "POST" && url.pathname === "/webhook") {
      if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TG_SECRET) {
        return new Response("Unauthorized", { status: 403 });
      }
      return handleTelegramUpdate(request, env, ctx);
    }

    if (request.method === "POST" && url.pathname === "/approve") {
      return handleApprove(request, env, ctx);
    }

    return new Response("Bot is running. System is fully operational.");
  },

  async scheduled(event, env, ctx) {
    try {
      const now = Math.floor(Date.now() / 1000);
      await env.DB.prepare("DELETE FROM verify_sessions WHERE expires_at < ?").bind(now).run();
    } catch (e) {
      console.error(e);
    }
  }
}

async function handleTelegramUpdate(request, env, ctx) {
  try {
    const update = await request.json();

    if (update.chat_join_request) {
      await sendVerificationLink(env, request.url, update.chat_join_request, "join_request");
      return new Response("Ok");
    }

    if (update.message) {
      const msg = update.message;
      const chatId = msg.chat.id;
      const chatType = msg.chat.type;
      
      if (msg.new_chat_members) {
        const selfJoinMembers = [];
        for (const member of msg.new_chat_members) {
           if (member.is_bot) continue;
           if (msg.from && msg.from.id !== member.id) continue; 
           selfJoinMembers.push(member);
        }

        if (selfJoinMembers.length === 0) return new Response("Ok");
        const chatInfo = await getChatInfo(env, chatId);
        if (chatInfo && chatInfo.join_by_request) return new Response("Ok");
        
        await Promise.all(selfJoinMembers.map(async (member) => {
          const safeName = member.first_name.replace(/</g, "&lt;").replace(/>/g, "&gt;");
          const sentMsg = await sendMessage(env, chatId, CONFIG.direct_join_msg.replace("{name}", safeName));
          const verifyMsgId = sentMsg.result ? sentMsg.result.message_id : 0;
          const joinMsgId = msg.message_id;
          
          if (verifyMsgId) {
              const deepLinkPayload = `verify_${chatId}_${joinMsgId}_${verifyMsgId}`;
              const deepLink = `https://t.me/${CONFIG.bot_username}?start=${deepLinkPayload}`;
              await editMessageReplyMarkup(env, chatId, verifyMsgId, {
                  inline_keyboard: [[{ text: CONFIG.direct_join_btn, url: deepLink }]]
              });
          }
        }));
        return new Response("Ok");
      }

      let text = msg.text || "";
      if (text.startsWith("/")) {
        const match = text.match(/^\/[a-zA-Z0-9_]+@([a-zA-Z0-9_]+)/);
        if (match && match[1].toLowerCase() !== CONFIG.bot_username.toLowerCase()) return new Response("Ok");
      }
      if (CONFIG.bot_username && text.includes(`@${CONFIG.bot_username}`)) {
        text = text.replace(`@${CONFIG.bot_username}`, "").trim();
      }

      if (text.startsWith("/start")) {
        const args = text.split(" ");
        if (chatType === "private" && args.length > 1 && args[1].startsWith("verify_")) {
           const parts = args[1].replace("verify_", "").split("_");
           const targetChatId = parts[0];
           const joinMsgId = parts[1] || 0;
           const verifyMsgId = parts[2] || 0;
           const mockReq = { chat: { id: targetChatId, title: "群聊" }, from: msg.from };
           await sendVerificationLink(env, request.url, mockReq, "direct_member", { jmid: joinMsgId, vmid: verifyMsgId });
           return new Response("Ok");
        }
        if (chatType === "private") await sendMessage(env, chatId, CONFIG.private_start_msg);
        else await sendMessage(env, chatId, CONFIG.group_start_msg);
      }
      else if (text.startsWith("/help")) {
          if (chatType === "private") {
            const permissions = "invite_users+restrict_members+delete_messages+pin_messages";
            const addUrl = `https://t.me/${CONFIG.bot_username}?startgroup=true&admin=${permissions}`;
            await sendMessage(env, chatId, CONFIG.private_help_msg, { inline_keyboard: [[{ text: CONFIG.private_help_btn, url: addUrl }]] });
          } else {
            const pmUrl = `https://t.me/${CONFIG.bot_username}?start=help`;
            await sendMessage(env, chatId, CONFIG.group_help_msg, { inline_keyboard: [[{ text: CONFIG.group_help_btn, url: pmUrl }]] });
          }
      }
    }
  } catch (e) { 
      console.error(e);
  }
  return new Response("Ok");
}

async function sendVerificationLink(env, currentUrl, reqData, mode, extraIds = {}) {
  const workerOrigin = new URL(currentUrl).origin;
  const userName = reqData.from.first_name || "用户";
  const sessionData = {
      cid: reqData.chat.id,
      uid: reqData.from.id,
      mode: mode,
      name: encodeURIComponent(userName),
      jmid: extraIds.jmid || "0",
      vmid: extraIds.vmid || "0"
  };

  const token = crypto.randomUUID().replace(/-/g, '').substring(0, 10);
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + 600;
  
  try {
      await env.DB.prepare("INSERT INTO verify_sessions (token, session_data, expires_at) VALUES (?, ?, ?)")
          .bind(token, JSON.stringify(sessionData), expiresAt).run();
  } catch (e) { 
      await sendMessage(env, reqData.from.id, "系统繁忙，生成验证链接失败，请稍后再试。");
      return;
  }
  
  const shortUrl = `${workerOrigin}/s/${token}`;
  const text = CONFIG.verify_request_text.replace("{chat_title}", reqData.chat.title || "群聊");
  
  await sendMessage(env, reqData.from.id, text, {
    inline_keyboard: [[{ text: CONFIG.verify_button_text, url: shortUrl }]]
  });
}

async function handleVerifyPage(token, env) {
  const now = Math.floor(Date.now() / 1000);
  let sessionDataStr = null;
  
  try {
      const { results } = await env.DB.prepare("SELECT session_data FROM verify_sessions WHERE token = ? AND expires_at > ?")
          .bind(token, now).all();
      if (results && results.length > 0) sessionDataStr = results[0].session_data;
  } catch (e) { }

  if (!sessionDataStr) {
    return new Response("此验证链接已过期或无效。请返回群组重新点击验证按钮。", { 
      status: 404, headers: { "Content-Type": "text/plain;charset=UTF-8" } 
    });
  }

  const html = `
<!DOCTYPE html>
<html>
<head>
  <title>${CONFIG.page_title}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
  <script src="https://www.google.com/recaptcha/api.js" async defer></script>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; display: flex; justify-content: center; alignItems: center; height: 100vh; background: #f0f2f5; margin: 0; flex-direction: column; }
    .card { background: white; padding: 2rem; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); text-align: center; max-width: 90%; width: 350px; }
    h2 { margin-top: 0; margin-bottom: 1rem; color: #1a1a1a; font-size: 24px;}
    p { color: #666; margin-bottom: 20px; }
    #status { margin-top: 15px; font-weight: 500; min-height: 24px; }
    .notice { font-size: 13px; color: #d93025; margin-top: 10px; display: none; }
    .visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); border: 0; }
  </style>
</head>
<body>
  <div class="card">
    <h2>${CONFIG.page_header}</h2>
    <p id="descText">${CONFIG.page_desc}</p>
    
    <form id="verifyForm" style="display:flex; justify-content:center;">
      <input type="text" id="email_address" name="email_address" class="visually-hidden" tabindex="-1" autocomplete="off" value="">
      <div id="cf-container" class="cf-turnstile" data-sitekey="${env.TURNSTILE_SITE_KEY}" data-callback="onTurnstileSuccess"></div>
      <div id="google-container" style="display:none;">
          <div class="g-recaptcha" data-sitekey="${env.GOOGLE_SITE_KEY}" data-callback="onGoogleSuccess"></div>
      </div>
    </form>
    
    <div id="status"></div>
    <div id="extendedNotice" class="notice">环境检测存在异常，已触发加强防机器验证。<br>验证时间已延长至 30 分钟。</div>
  </div>

  <script>
    let pageLoadTime = Date.now();
    
    function detectBot() {
        let score = 0;
        if (navigator.webdriver) score += 10;
        if (window.callPhantom || window._phantom || window.phantom) score += 10;
        if (window.__nightmare) score += 10;
        if (window.domAutomation || window.domAutomationController) score += 10;
        if (navigator.plugins.length === 0 && navigator.userAgent.indexOf('Android') === -1) score += 2;
        return score;
    }

    function onTurnstileSuccess(turnstileToken) {
      let timeTaken = Date.now() - pageLoadTime;
      let botScore = detectBot();
      
      if (timeTaken < 1500 || botScore >= 10) {
          document.getElementById('cf-container').style.display = 'none';
          document.getElementById('google-container').style.display = 'block';
          document.getElementById('extendedNotice').style.display = 'block';
          document.getElementById('descText').innerText = "请完成下方额外的谷歌人机验证：";
          
          fetch('/approve', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'extend', sessionToken: "${token}" })
          });
      } else {
          submitVerification('turnstile', turnstileToken);
      }
    }

    function onGoogleSuccess(googleToken) {
      submitVerification('google', googleToken);
    }

    function submitVerification(captchaType, captchaToken) {
      const trapValue = document.getElementById('email_address').value;
      
      document.getElementById('status').innerText = "${CONFIG.page_status_verifying}";
      document.getElementById('status').style.color = "#1a73e8";
      
      fetch('/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'verify', captchaType: captchaType, captchaToken: captchaToken, sessionToken: "${token}", trap: trapValue })
      })
      .then(res => res.json())
      .then(data => {
        if (data.success) {
          document.getElementById('status').innerText = "${CONFIG.page_status_success}";
          document.getElementById('status').style.color = "#1e8e3e";
          document.getElementById('verifyForm').style.display = 'none';
          setTimeout(() => window.location.href = "tg://resolve?domain=telegram", 1500);
        } else {
          document.getElementById('status').innerText = data.msg || "${CONFIG.page_status_fail}";
          document.getElementById('status').style.color = "#d93025";
        }
      })
      .catch(err => {
          document.getElementById('status').innerText = "❌ 网络或服务器错误";
      });
    }
  </script>
</body>
</html>
  `;
  return new Response(html, { headers: { "Content-Type": "text/html;charset=UTF-8" } });
}

async function handleApprove(request, env, ctx) {
  try {
      const body = await request.json();
      const { action, captchaType, captchaToken, sessionToken, trap } = body;
      const now = Math.floor(Date.now() / 1000);

      if (trap && trap.length > 0) {
          return Response.json({ success: false, msg: "检测到非法请求" }, { status: 403 });
      }

      if (action === 'extend') {
          await env.DB.prepare("UPDATE verify_sessions SET expires_at = ? WHERE token = ?")
              .bind(now + 1800, sessionToken).run();
          return Response.json({ success: true, msg: "Extended" });
      }

      const remoteIp = request.headers.get("CF-Connecting-IP");
      let sessionDataStr = null;

      try {
          const { results } = await env.DB.prepare("SELECT session_data FROM verify_sessions WHERE token = ? AND expires_at > ?")
              .bind(sessionToken, now).all();
          if (results && results.length > 0) sessionDataStr = results[0].session_data;
      } catch (e) { }

      if (!sessionDataStr) return Response.json({ success: false, msg: "验证链接已超时或失效" });
      
      const sessionData = JSON.parse(sessionDataStr);
      const { cid, uid, mode, name, jmid, vmid } = sessionData;

      let verifySuccess = false;
      
      if (captchaType === "google") {
          const googleData = new URLSearchParams();
          googleData.append("secret", env.GOOGLE_SECRET_KEY);
          googleData.append("response", captchaToken);
          googleData.append("remoteip", remoteIp);

          const googleRes = await fetch("https://www.google.com/recaptcha/api/siteverify", {
              method: "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: googleData.toString(),
          });
          const googleResult = await googleRes.json();
          verifySuccess = googleResult.success;
      } else if (captchaType === "turnstile") {
          const cfFormData = new FormData();
          cfFormData.append("secret", env.TURNSTILE_SECRET_KEY);
          cfFormData.append("response", captchaToken);
          cfFormData.append("remoteip", remoteIp);

          const cfRes = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
                method: "POST", body: cfFormData
          });
          const cfResult = await cfRes.json();
          verifySuccess = cfResult.success;
      }

      if (!verifySuccess) return Response.json({ success: false, msg: "人机验证失败，请重试" });

      let actionSuccess = false;
      let safeName = "用户";
      try { 
          if (name) safeName = decodeURIComponent(name).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      } catch(e) {}

      if (mode === 'join_request') {
          const res = await callApi(env, "approveChatJoinRequest", { chat_id: cid, user_id: uid });
          if (res.ok || (res.description && (res.description.includes("already") || res.description.includes("member")))) {
              actionSuccess = true;
          } else if (res.description && res.description.includes("rights")) {
              return Response.json({ success: false, msg: "Bot 缺少管理员权限，请联系群管" });
          }
          if (actionSuccess) await sendMessage(env, uid, CONFIG.verify_pass_private_msg).catch(() => {});
      } else {
          const mention = `<a href="tg://user?id=${uid}">${safeName}</a>`;
          const groupText = CONFIG.verify_pass_group_msg.replace("{mention}", mention);
          const res = await sendMessage(env, cid, groupText);
          actionSuccess = true;
          
          if (res.ok && res.result && CONFIG.auto_delete_success_msg_sec > 0) {
              const successMsgId = res.result.message_id;
              const safeSleepTime = Math.min(CONFIG.auto_delete_success_msg_sec, 5);
              ctx.waitUntil(
                  sleep(safeSleepTime * 1000).then(() => deleteMessage(env, cid, successMsgId)).catch(() => {})
              );
          }
          await sendMessage(env, uid, CONFIG.verify_pass_private_msg).catch(() => {});
      }

      if (actionSuccess) {
          ctx.waitUntil(env.DB.prepare("DELETE FROM verify_sessions WHERE token = ?").bind(sessionToken).run());
      }

      if (mode === 'direct_member') {
          ctx.waitUntil((async () => {
              try {
                  if (vmid && vmid !== "0") {
                      const delRes = await deleteMessage(env, cid, vmid);
                      if (!delRes.ok) {
                          await callApi(env, "editMessageText", {
                              chat_id: cid, message_id: vmid,
                              text: `${CONFIG.direct_join_msg.replace("{name}", safeName)}\n\n<b>✅ 验证已通过</b>`,
                              parse_mode: "HTML", reply_markup: { inline_keyboard: [] }
                          }).catch(() => {}); 
                      }
                  }
                  if (jmid && jmid !== "0") await deleteMessage(env, cid, jmid);
              } catch (err) {}
          })());
      }

      return Response.json({ success: actionSuccess });
  } catch (e) {
      return Response.json({ success: false, msg: "系统内部错误" });
  }
}

async function getChatInfo(env, chatId) {
  const res = await callApi(env, "getChat", { chat_id: chatId });
  if (res.ok) return res.result;
  return null;
}
            
async function callApi(env, method, payload) {
    const url = `https://api.telegram.org/bot${env.TG_BOT_TOKEN}/${method}`;
    try {
        const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
        return await response.json(); 
    } catch (e) {
        return { ok: false, description: "Network Error" };
    }
}

async function sendMessage(env, chatId, text, extra = {}) {
  const payload = { chat_id: chatId, text, parse_mode: "HTML" };
  if (extra.inline_keyboard) payload.reply_markup = { inline_keyboard: extra.inline_keyboard };
  else if (extra.reply_markup) payload.reply_markup = extra.reply_markup;
  
  return callApi(env, "sendMessage", payload).catch(() => ({ ok: false }));
}

async function editMessageReplyMarkup(env, chatId, messageId, replyMarkup) {
  return callApi(env, "editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: replyMarkup })
    .catch(() => ({ ok: false }));
}

async function deleteMessage(env, chatId, messageId) {
  return callApi(env, "deleteMessage", { chat_id: chatId, message_id: messageId })
    .catch(() => ({ ok: false }));
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
