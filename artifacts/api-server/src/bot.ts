import {
  addAdmin,
  addChannel,
  addMilestone,
  addProduct,
  addStock,
  adminList,
  adminProducts,
  adjustPoints,
  adjustUser,
  allChannels,
  audit,
  auditRows,
  broadcastJob,
  broadcastProgress,
  broadcastUsers,
  channels,
  completeReferral,
  createBroadcast,
  dashboard,
  deleteProduct,
  finishClaim,
  getSetting,
  isAdmin,
  isOwner,
  markStatus,
  milestones,
  pendingBroadcasts,
  product,
  products,
  profile,
  referralStats,
  removeAdmin,
  removeChannel,
  reserveCoupon,
  rewards,
  setBroadcastStatus,
  setMilestone,
  setProduct,
  setSetting,
  unlockMilestones,
  upsertUser,
  userById,
  userRows,
} from "./db";

type AnyRecord = Record<string, any>;
type Markup = AnyRecord;

const token = () => process.env.BOT_TOKEN ?? "";
const adminStates = new Map<number, AnyRecord>();
let botUsername = "";
const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const DEFAULT_DISCLAIMER =
  "⚠️ IMPORTANT WARNING: Rewards are added to the bot in bulk, so occasionally you may receive a duplicate, expired, already-used, invalid, or non-working reward. If you receive only 1–2 such rewards, please do not contact Support, as minor issues can happen during bulk distribution. However, if you repeatedly receive the same issue across multiple rewards, you may contact the Support Bot and an admin will review the situation and assist where possible. By clicking Accept & Continue, you confirm that you understand and accept these terms.";

async function mainKeyboard(chatId: number): Promise<Markup> {
  const referralsEnabled = (await getSetting("referrals_enabled", "true")) === "true";
  const keyboard: AnyRecord[][] = [
    [{ text: "🎁 Browse Rewards" }],
    referralsEnabled ? [{ text: "👥 Refer & Earn" }, { text: "🏆 My Rewards" }] : [{ text: "🏆 My Rewards" }],
    [{ text: "👤 Profile" }, { text: "📘 How It Works" }],
    [{ text: "💬 Support" }],
  ];
  if (await isAdmin(chatId)) keyboard.push([{ text: "⚙️ Admin Panel" }]);
  return {
    keyboard,
    resize_keyboard: true,
    is_persistent: true,
  };
}

const homeButton = () => ({ inline_keyboard: [[{ text: "🏠 Home", callback_data: "home" }]] });

const inline = (...rows: AnyRecord[][]): Markup => ({ inline_keyboard: rows });

function buttonStyle(text: string): "primary" | "success" | "danger" {
  const normalized = text.toLowerCase();
  if (/(delete|remove|disable|ban|cancel|failed|out of stock|disclaimer)/.test(normalized)) {
    return "danger";
  }
  if (/(accept|continue|start|check|enable|add|confirm|send|claim|share|open|stock|milestone|broadcast|content|refer|reward|coupon|support)/.test(normalized)) {
    return "success";
  }
  return "primary";
}

function styledMarkup(markup?: Markup): Markup | undefined {
  if (!markup) return markup;
  const keyboardKey = markup.inline_keyboard ? "inline_keyboard" : markup.keyboard ? "keyboard" : undefined;
  if (!keyboardKey) return markup;
  return {
    ...markup,
    [keyboardKey]: markup[keyboardKey].map((row: AnyRecord[]) =>
      row.map((item) => ({
        ...item,
        ...(typeof item.text === "string" ? { style: buttonStyle(item.text) } : {}),
      })),
    ),
  };
}

const adminNav = (back = "admin:home") =>
  inline(
    [{ text: "🏠 Admin Home", callback_data: "admin:home" }],
    [{ text: "⬅️ Back", callback_data: back }],
  );

async function telegram(method: string, body: AnyRecord = {}) {
  const response = await fetch(`https://api.telegram.org/bot${token()}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await response.json()) as AnyRecord;
  if (!data.ok) {
    const error = new Error(`${method}: ${data.description ?? "Telegram API error"}`);
    (error as AnyRecord).response = data;
    throw error;
  }
  return data.result;
}

async function send(chatId: number, text: string, replyMarkup?: Markup, parseMode?: "HTML") {
  return telegram("sendMessage", {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
    ...(parseMode ? { parse_mode: parseMode } : {}),
    ...(replyMarkup ? { reply_markup: styledMarkup(replyMarkup) } : {}),
  });
}

async function edit(chatId: number, messageId: number, text: string, replyMarkup?: Markup, parseMode?: "HTML") {
  try {
    return await telegram("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      disable_web_page_preview: true,
      ...(parseMode ? { parse_mode: parseMode } : {}),
      ...(replyMarkup ? { reply_markup: styledMarkup(replyMarkup) } : {}),
    });
  } catch (error) {
    if (String(error).includes("message is not modified")) return;
    throw error;
  }
}

async function callback(id: string, text = "") {
  await telegram("answerCallbackQuery", { callback_query_id: id, text }).catch(() => undefined);
}

function prettyDate(value: unknown) {
  if (!value) return "—";
  return new Date(String(value)).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
}

function num(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message.slice(0, 250) : "unknown error";
}

function html(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function previewText(value: unknown, limit = 150) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return html(text.slice(0, limit)) + (text.length > limit ? "…" : "");
}

function supportLink(value: unknown) {
  const raw = String(value ?? "").trim();
  if (/^https?:\/\//i.test(raw)) return raw;
  return `https://t.me/${raw.replace(/^@/, "")}`;
}

function progressBar(current: number, total: number, width = 10) {
  const percent = total ? Math.min(100, Math.round((current / total) * 100)) : 100;
  const filled = Math.round((percent / 100) * width);
  return `${"▰".repeat(filled)}${"▱".repeat(width - filled)} ${percent}%`;
}

async function safe(fn: () => Promise<void>, chatId?: number) {
  try {
    await fn();
  } catch (error) {
    console.error("bot operation failed", error);
    if (chatId) await send(chatId, "❌ Something went wrong. Please try again.").catch(() => undefined);
  }
}

async function maintenanceMessage() {
  return getSetting("maintenance_message", "🛠️ The bot is temporarily under maintenance.");
}

async function protectedUser(id: number) {
  const user = await userById(id);
  if (!user) return false;
  if (user.banned) {
    await send(id, "🚫 Your account is restricted. Please contact Support.");
    return false;
  }
  if ((await getSetting("maintenance_enabled", "false")) === "true") {
    await send(id, await maintenanceMessage());
    return false;
  }
  return true;
}

async function showWelcome(chatId: number, messageId?: number) {
  const text = await getSetting("welcome");
  const required = await channels();
  const markup = required.length
    ? inline(
        ...required.map((channel) => [
          { text: `📢 ${channel.title}`, url: String(channel.invite_link) },
        ]),
        [{ text: "🔄 Check Subscription", callback_data: "check_sub" }],
      )
    : inline([{ text: "➡️ Continue", callback_data: "check_sub" }]);
  const content =
    required.length > 0
      ? `✨ <b>FREE COUPON HUB</b>\n\n${html(text)}\n\n📢 <b>Join every required channel</b>\nThen tap <b>Check Subscription</b> to continue.`
      : `✨ <b>FREE COUPON HUB</b>\n\n${html(text)}`;
  if (messageId) await edit(chatId, messageId, content, markup, "HTML");
  else await send(chatId, content, markup, "HTML");
}

async function checkSubscriptions(userId: number) {
  const required = await channels();
  for (const channel of required) {
    try {
      const member = await telegram("getChatMember", {
        chat_id: channel.chat_id,
        user_id: userId,
      });
      if (["left", "kicked"].includes(member.status)) return false;
    } catch (error) {
      console.error("subscription check failed", error);
      return false;
    }
  }
  return true;
}

async function showDisclaimer(chatId: number, messageId?: number) {
  const enabled = (await getSetting("disclaimer_enabled", "true")) === "true";
  if (!enabled) {
    await showStartUsing(chatId, messageId);
    return;
  }
  const text = await getSetting("disclaimer", DEFAULT_DISCLAIMER);
  const content = `🛡️ <b>BEFORE YOU CONTINUE</b>\n\n${html(text)}`;
  const markup = inline([{ text: "✅ Accept & Continue", callback_data: "accept_disclaimer" }]);
  if (messageId) await edit(chatId, messageId, content, markup, "HTML");
  else await send(chatId, content, markup, "HTML");
}

async function showStartUsing(chatId: number, messageId?: number) {
  const text = "✅ <b>YOU'RE ALL SET!</b>\n\nWelcome to Free Coupon Hub.\nYou can now start earning rewards by referring friends.";
  const markup = inline([{ text: "🚀 Start Using", callback_data: "start_using" }]);
  if (messageId) await edit(chatId, messageId, text, markup, "HTML");
  else await send(chatId, text, markup, "HTML");
}

async function showHome(chatId: number, editMessageId?: number) {
  const summary = await profile(chatId);
  const milestonesList = await milestones();
  const referralsEnabled = (await getSetting("referrals_enabled", "true")) === "true";
  const valid = num(summary.stats.valid);
  const next = milestonesList.find(
    (milestone) => milestone.enabled && num(milestone.required_valid_referrals) > valid,
  );
  const remaining = next ? Math.max(0, num(next.required_valid_referrals) - valid) : 0;
  const name = html(summary.user?.first_name || "there");
  const text =
    `✨ <b>FREE COUPON HUB</b>\n\n` +
    `👋 Welcome back, <b>${name}</b>\n` +
    `Your reward dashboard is ready.\n\n` +
    `💎 Points: <b>${summary.user?.points ?? 0}</b>\n` +
    (referralsEnabled
      ? `✅ Valid referrals: <b>${valid}</b>\n` +
        `🎯 Next milestone: <b>${html(next ? `${next.required_valid_referrals} referrals → ${next.product_name}` : "All milestones unlocked")}</b>\n` +
        (next ? `📌 Remaining: <b>${remaining}</b>\n\n` : "\n")
      : `⏸️ Referral program: <b>Temporarily paused</b>\n\n`) +
    `Choose an option below to continue.`;
  if (editMessageId) {
    await edit(
      chatId,
      editMessageId,
      text,
      inline(
        [{ text: "🎁 Browse Rewards", callback_data: "stock:0" }],
        [{ text: "👥 Refer & Earn", callback_data: "home_referral" }, { text: "🏆 My Rewards", callback_data: "home_rewards" }],
        [{ text: "🏠 Refresh Home", callback_data: "home_menu" }],
      ),
      "HTML",
    );
  } else {
    await send(chatId, text, await mainKeyboard(chatId), "HTML");
  }
}

async function startOnboarding(message: AnyRecord) {
  const id = num(message.from?.id);
  const arg = String(message.text ?? "").split(/\s+/)[1];
  const referrerId = arg && /^\d+$/.test(arg) ? Number(arg) : undefined;
  const result = await upsertUser({
    id,
    username: message.from?.username,
    firstName: message.from?.first_name,
    referrerId,
  });
  if (result.referrerId) {
    await send(
      result.referrerId,
      "🔔 𝗡𝗘𝗪 𝗥𝗘𝗙𝗘𝗥𝗥𝗔𝗟!\n\nSomeone joined using your link! ⏳ Waiting for them to join the required channels and accept the disclaimer.",
    ).catch(() => undefined);
  }
  if (!result.isNew && result.status === "completed") {
    if (await protectedUser(id)) await showHome(id);
    return;
  }
  const required = await channels();
  if (required.length) {
    await showWelcome(id);
  } else {
    await markStatus(id, "subscribed");
    await showDisclaimer(id);
  }
}

async function startUsing(id: number, messageId?: number) {
  await markStatus(id, "completed");
  const referral = await completeReferral(id);
  if (referral) {
    await send(
      referral.referrerId,
      `🔔 𝗥𝗘𝗙𝗘𝗥𝗥𝗔𝗟 𝗦𝗨𝗖𝗖𝗘𝗦𝗦!\n\nYou’ve got a new valid referral! 🎉\n\n👥 Total: ${referral.total}\n✅ Valid: ${referral.valid}\n❌ Non-Valid: ${referral.pending}\n\n🎁 Keep going — your next reward is getting closer!`,
    ).catch(() => undefined);
    const freshRewards = await unlockMilestones(referral.referrerId);
    for (const reward of freshRewards) {
      await send(
        referral.referrerId,
        `🎉 REWARD UNLOCKED!\n\nYou completed ${reward.required_valid_referrals} valid referrals.\n\n🎁 ${reward.product_name}`,
        inline([{ text: "🎟️ Claim Reward", callback_data: `reward:${reward.milestone_id}` }]),
      ).catch(() => undefined);
    }
  }
  if (messageId) await edit(id, messageId, "✅ You're all set!\n\nYour account is ready.", homeButton());
  await showHome(id);
}

async function showReferral(id: number) {
  if ((await getSetting("referrals_enabled", "true")) !== "true") {
    await send(id, "⏸️ <b>REFERRAL PROGRAM PAUSED</b>\n\nReferrals are temporarily unavailable. Please check back later.", homeButton(), "HTML");
    return;
  }
  const stats = await referralStats(id);
  const valid = num(stats.valid);
  const milestonesList = await milestones();
  const next = milestonesList.find((milestone) => milestone.enabled && num(milestone.required_valid_referrals) > valid);
  const remaining = next ? Math.max(0, num(next.required_valid_referrals) - valid) : 0;
  const link = `https://t.me/${botUsername}?start=${id}`;
  await send(
    id,
    `👥 <b>REFER &amp; EARN</b>\n\n` +
      `Invite friends and unlock free rewards together.\n\n` +
      `🔗 <b>Your referral link</b>\n<code>${html(link)}</code>\n\n` +
      `📊 <b>Your progress</b>\n` +
      `👥 Total: <b>${stats.total}</b>  ·  ✅ Valid: <b>${stats.valid}</b>\n` +
      `⏳ Pending: <b>${stats.pending}</b>\n\n` +
      `🎯 <b>Next milestone</b>\n` +
      `${html(next ? `${next.required_valid_referrals} valid referrals → ${next.product_name}` : "All available milestones unlocked")}\n` +
      `${next ? `${progressBar(valid, num(next.required_valid_referrals))}\n📌 ${remaining} more valid referral${remaining === 1 ? "" : "s"} to go.` : "🎉 You have unlocked every available milestone."}`,
    inline(
      [{ text: "📤 Share Referral Link", url: `https://t.me/share/url?url=${encodeURIComponent(link)}` }],
      [{ text: "🏠 Home", callback_data: "home_menu" }],
    ),
    "HTML",
  );
}

async function showStock(id: number, page = 0, messageId?: number) {
  const rows = await products(page);
  let text = "🎁 <b>REWARD CATALOG</b>\n\nChoose a reward to view its requirements and live availability.\n\n";
  if (!rows.length) text += "No rewards are available right now. Please check back soon.";
  for (const row of rows) {
    text += `🎁 <b>${html(row.name)}</b>\n💎 ${row.required_points} points  ·  ${num(row.stock) > 0 ? `📦 <b>${row.stock} available</b>` : "🔴 <b>Out of stock</b>"}\n\n`;
  }
  const buttons = rows.map((row) => [
    {
      text: `${num(row.stock) > 0 ? "🎟️" : "📦"} ${row.name}`,
      callback_data: `product:${row.id}`,
    },
  ]);
  buttons.push([
    ...(page > 0 ? [{ text: "◀️ Previous", callback_data: `stock:${page - 1}` }] : []),
    ...(rows.length === 6 ? [{ text: "Next ▶️", callback_data: `stock:${page + 1}` }] : []),
  ]);
  buttons.push([{ text: "🏠 Home", callback_data: "home_menu" }]);
  if (messageId) await edit(id, messageId, text, inline(...buttons), "HTML");
  else await send(id, text, inline(...buttons), "HTML");
}

async function showProduct(id: number, productId: number, messageId?: number) {
  const row = await product(productId);
  if (!row) {
    await send(id, "❌ This product is no longer available.", homeButton());
    return;
  }
  const stock = num(row.stock);
  const text =
    `🎁 <b>${html(row.name)}</b>\n\n` +
    `💎 Cost: <b>${row.required_points} points</b>\n` +
    `📦 Live stock: <b>${stock > 0 ? `${stock} available` : "OUT OF STOCK"}</b>\n` +
    `📖 How to use: <b>${row.how_to_use ? "Included after claiming" : "Not configured yet"}</b>\n\n` +
    `${stock > 0 ? "Ready to claim? Your coupon will be delivered in a separate message." : "This reward is temporarily unavailable."}`;
  const markup = inline(
    ...(stock > 0 ? [[{ text: "🎟️ Claim Coupon", callback_data: `claim:${row.id}` }]] : []),
    [{ text: "⬅️ Back", callback_data: "stock:0" }],
    [{ text: "🏠 Home", callback_data: "home_menu" }],
  );
  if (messageId) await edit(id, messageId, text, markup, "HTML");
  else await send(id, text, markup, "HTML");
}

async function claimProduct(id: number, productId: number, milestoneId?: number) {
  const reserved = await reserveCoupon(id, productId, milestoneId);
  if ("error" in reserved) {
    const messages: Record<string, string> = {
      banned: "🚫 Your account is restricted.",
      unavailable: "❌ This reward is disabled or unavailable.",
      points: "❌ You don't have enough points/referrals to claim this reward.",
      locked: "❌ This reward has not been unlocked yet.",
      already: "✅ You have already claimed this reward.",
      stock: "❌ This reward is currently out of stock.",
    };
    const reason = reserved.error;
    await send(id, messages[reason ?? "unavailable"] ?? "❌ This reward is currently unavailable.", homeButton());
    return;
  }
  let claimFinalized = false;
  try {
    await send(id, `🎉 <b>COUPON CLAIMED!</b>\n\n🎁 Your reward is ready.\n💎 Keep this code safe.\n\n<code>${html(reserved.code)}</code>`, undefined, "HTML");
    await finishClaim(reserved.claimId, true);
    claimFinalized = true;
    if (String(reserved.howToUse ?? "").trim()) {
      await send(id, `📖 <b>HOW TO USE</b>\n\n${html(reserved.howToUse)}`, undefined, "HTML");
    }
  } catch (error) {
    if (!claimFinalized) {
      await finishClaim(reserved.claimId, false, errorText(error));
      await send(id, "❌ Delivery failed temporarily. Your coupon was returned to stock. Please try again.", homeButton()).catch(() => undefined);
    } else {
      await send(id, "⚠️ Your coupon was delivered, but the How to Use message could not be sent. Please contact support.", homeButton()).catch(() => undefined);
    }
  }
}

async function showRewards(id: number) {
  await unlockMilestones(id);
  const rows = await rewards(id);
  let text = "🏆 <b>MY REWARDS</b>\n\n";
  if (!rows.length) text += "Complete referral milestones to unlock your first reward.";
  const buttons: AnyRecord[][] = [];
  for (const row of rows) {
    text += `🎁 <b>${html(row.product_name)}</b>\n🎯 Unlocked at ${row.required_valid_referrals} valid referrals\n${row.status === "claimed" ? `✅ Claimed on ${prettyDate(row.claimed_at)}\n` : `🟢 Ready to claim${num(row.stock) > 0 ? "" : " · currently out of stock"}\n`}\n`;
    if (row.status !== "claimed") {
      buttons.push([{ text: `🎟️ Claim ${row.product_name}`, callback_data: `reward:${row.milestone_id}` }]);
    }
  }
  buttons.push([{ text: "🏠 Home", callback_data: "home_menu" }]);
  await send(id, text, inline(...buttons), "HTML");
}

async function claimReward(id: number, milestoneId: number) {
  const rows = await rewards(id);
  const reward = rows.find((row) => num(row.milestone_id) === milestoneId);
  if (!reward) {
    await send(id, "❌ This reward is not unlocked yet.", homeButton());
    return;
  }
  await claimProduct(id, num(reward.product_id), milestoneId);
}

async function showProfile(id: number) {
  const result = await profile(id);
  await send(
    id,
    `👤 <b>MY PROFILE</b>\n\n🆔 Telegram ID: <code>${id}</code>\n👤 Name: <b>${html(result.user?.first_name)}</b>\n🔗 Username: ${result.user?.username ? `@${html(result.user.username)}` : "—"}\n📅 Joined: ${prettyDate(result.user?.joined_at)}\n💎 Points: <b>${result.user?.points ?? 0}</b>\n\n👥 Total referrals: ${result.stats.total}\n✅ Valid referrals: ${result.stats.valid}\n⏳ Pending: ${result.stats.pending}\n🎁 Claimed rewards: ${result.rewards.filter((reward) => reward.status === "claimed").length}`,
    homeButton(),
    "HTML",
  );
}

async function showHow(id: number) {
  await send(
    id,
    "📘 <b>HOW IT WORKS</b>\n\n① Join every required channel.\n② Accept the disclaimer and activate your account.\n③ Share your personal referral link.\n④ A referral becomes valid after the new user completes onboarding.\n⑤ Reach a milestone and claim the unlocked reward.\n⑥ Your coupon and product instructions arrive in separate messages.\n\n💡 Tip: Check <b>My Rewards</b> whenever you complete a milestone.",
    homeButton(),
    "HTML",
  );
}

async function showSupport(id: number) {
  const username = await getSetting("support_username", "SupportBot");
  const message = await getSetting("support_message", "For help, contact our Support Bot.");
  await send(id, `💬 <b>SUPPORT</b>\n\n${html(message)}`, inline([{ text: "💬 Open Support Bot", url: supportLink(username) }], [{ text: "🏠 Home", callback_data: "home_menu" }]), "HTML");
}

async function adminPanel(id: number, messageId?: number) {
  if (!(await isAdmin(id))) {
    await send(id, "🚫 Access denied.");
    return;
  }
  const text =
    "⚙️ <b>ADMIN CONTROL CENTER</b>\n\n" +
    "Manage rewards, users, content, and bot operations from one place.\n\n" +
    "📦 <b>Operations</b> · monitor stock and broadcasts\n" +
    "👥 <b>Growth</b> · manage referrals, users, and channels\n" +
    "🛠️ <b>Configuration</b> · edit content and settings";
  const markup = inline(
    [{ text: "📊 Dashboard", callback_data: "admin:dashboard" }, { text: "🎁 Stock", callback_data: "admin:stock" }],
    [{ text: "📢 Broadcast", callback_data: "admin:broadcast" }, { text: "🎯 Milestones", callback_data: "admin:milestones" }],
    [{ text: "👥 Users", callback_data: "admin:users" }, { text: "📢 Channels", callback_data: "admin:channels" }],
    [{ text: "📝 Content", callback_data: "admin:content" }, { text: "⚠️ Disclaimer", callback_data: "admin:disclaimer" }],
    [{ text: "🛠️ Settings", callback_data: "admin:settings" }, { text: "📜 Audit Logs", callback_data: "admin:audit" }],
    [{ text: "💎 Points Manager", callback_data: "admin:points" }, { text: "🔎 User Lookup", callback_data: "admin:lookup" }],
    [{ text: "📦 Low-Stock Monitor", callback_data: "admin:lowstock" }],
  );
  if (messageId) await edit(id, messageId, text, markup, "HTML");
  else await send(id, text, markup, "HTML");
}

async function adminDashboard(id: number, messageId: number) {
  const d = await dashboard();
  await edit(id, messageId, `📊 <b>DASHBOARD</b>\n\n👥 <b>Users</b>\nTotal: ${d.total_users}  ·  Active: ${d.active_users}\nNew today: ${d.new_users}  ·  Banned: ${d.banned_users}\n\n🎯 <b>Referrals</b>\nTotal: ${d.total_referrals}  ·  Valid: ${d.valid_referrals}\nPending: ${d.pending_referrals}\n\n🎁 <b>Rewards</b>\nProducts: ${d.products}  ·  Available stock: ${d.stock}\nClaims: ${d.claims}  ·  Failed: ${d.failed_claims}`, inline([{ text: "🔄 Refresh", callback_data: "admin:dashboard" }], [{ text: "⬅️ Back", callback_data: "admin:home" }]), "HTML");
}

async function adminStock(id: number, messageId: number) {
  const rows = await adminProducts();
  const totalStock = rows.reduce((sum, row) => sum + num(row.stock), 0);
  let text = `🎁 <b>STOCK MANAGEMENT</b>\n\n📦 Products: <b>${rows.length}</b>  ·  Available codes: <b>${totalStock}</b>\n\n`;
  for (const row of rows) {
    text += `🎁 <b>${html(row.name)}</b>\n💎 ${row.required_points} points  ·  📦 ${row.stock} available  ·  ${row.enabled ? "🟢 Enabled" : "🔴 Disabled"}  ·  ${row.how_to_use ? "📖 Guide ready" : "⚠️ Guide missing"}\n\n`;
  }
  if (!rows.length) text += "No products yet. Add your first product to start distributing rewards.\n";
  const buttons = rows.map((row) => [{ text: `✏️ ${row.name}`, callback_data: `admin:product:${row.id}` }]);
  buttons.push([{ text: "➕ Add Product", callback_data: "admin:addproduct" }]);
  buttons.push([{ text: "➕ Add Stock", callback_data: "admin:addstock" }]);
  buttons.push([{ text: "⬅️ Back", callback_data: "admin:home" }]);
  await edit(id, messageId, text, inline(...buttons), "HTML");
}

async function adminProduct(id: number, messageId: number, productId: number) {
  const row = await product(productId);
  if (!row) {
    await edit(id, messageId, "❌ <b>Product not found.</b>", inline([{ text: "⬅️ Back", callback_data: "admin:stock" }]), "HTML");
    return;
  }
  await edit(id, messageId, `🎁 <b>PRODUCT EDITOR</b>\n\n<b>${html(row.name)}</b>\n\n💎 Cost: <b>${row.required_points} points</b>\n📦 Available stock: <b>${row.stock}</b>\n📖 How to use: <b>${row.how_to_use ? "Configured" : "Not configured"}</b>\n${row.enabled ? "🟢 Enabled" : "🔴 Disabled"}`, inline(
    [{ text: row.enabled ? "🔴 Disable" : "🟢 Enable", callback_data: `admin:toggleproduct:${row.id}` }],
    [{ text: "➕ Add Stock", callback_data: `admin:addstock:${row.id}` }],
    [{ text: "📖 How to Use", callback_data: `admin:howto:${row.id}` }],
    [{ text: "🗑️ Delete", callback_data: `admin:deleteproduct:${row.id}` }],
    [{ text: "⬅️ Back", callback_data: "admin:stock" }],
  ), "HTML");
}

async function adminMilestones(id: number, messageId: number) {
  const rows = await milestones();
  let text = "🎯 <b>REFERRAL &amp; MILESTONES</b>\n\n";
  for (const row of rows) text += `🎯 <b>${row.required_valid_referrals}</b> referrals → ${html(row.product_name)} · ${row.enabled ? "🟢 Enabled" : "🔴 Disabled"}\n`;
  if (!rows.length) text += "No milestones yet.\n";
  const buttons = rows.map((row) => [{ text: `${row.enabled ? "🔴" : "🟢"} ${row.required_valid_referrals} → ${row.product_name}`, callback_data: `admin:togglemilestone:${row.id}:${row.enabled ? 0 : 1}` }]);
  buttons.push([{ text: "➕ Add Milestone", callback_data: "admin:addmilestone" }]);
  buttons.push([{ text: "⬅️ Back", callback_data: "admin:home" }]);
  await edit(id, messageId, text, inline(...buttons), "HTML");
}

async function adminChannels(id: number, messageId: number) {
  const rows = await allChannels();
  let text = "📢 <b>FORCE SUBSCRIBE</b>\n\n";
  for (const row of rows) text += `${row.enabled ? "🟢" : "🔴"} <b>${html(row.title)}</b> · <code>${html(row.chat_id)}</code>\n`;
  if (!rows.length) text += "No channels configured.\n";
  const buttons = rows.map((row) => [{ text: `🗑️ ${row.title}`, callback_data: `admin:deletechannel:${row.id}` }]);
  buttons.push([{ text: "➕ Add Channel", callback_data: "admin:addchannel" }]);
  buttons.push([{ text: "⬅️ Back", callback_data: "admin:home" }]);
  await edit(id, messageId, text, inline(...buttons), "HTML");
}

async function adminContent(id: number, messageId: number) {
  const welcome = await getSetting("welcome");
  const disclaimer = await getSetting("disclaimer", DEFAULT_DISCLAIMER);
  const supportMessage = await getSetting("support_message", "For help, contact our Support Bot.");
  const maintenanceMessageValue = await getSetting("maintenance_message", "🛠️ The bot is temporarily under maintenance. Please try again later.");
  const text =
    "📝 <b>CONTENT MANAGEMENT</b>\n\n" +
    "Edit the messages users see during onboarding and support.\n\n" +
    `👋 <b>Welcome</b>\n${previewText(welcome)}\n\n` +
    `⚠️ <b>Disclaimer</b>\n${previewText(disclaimer)}\n\n` +
    `💬 <b>Support Message</b>\n${previewText(supportMessage)}\n\n` +
    `🛠️ <b>Maintenance Message</b>\n${previewText(maintenanceMessageValue)}`;
  await edit(id, messageId, text, inline(
    [{ text: "✏️ Welcome", callback_data: "admin:editcontent:welcome" }, { text: "✏️ Disclaimer", callback_data: "admin:editcontent:disclaimer" }],
    [{ text: "✏️ Support Message", callback_data: "admin:editcontent:support_message" }],
    [{ text: "✏️ Maintenance Message", callback_data: "admin:editcontent:maintenance_message" }],
    [{ text: "👁️ Preview Welcome", callback_data: "admin:previewcontent:welcome" }],
    [{ text: "⬅️ Back", callback_data: "admin:home" }],
  ), "HTML");
}

async function adminSettings(id: number, messageId: number) {
  const enabled = (await getSetting("maintenance_enabled", "false")) === "true";
  const referralsEnabled = (await getSetting("referrals_enabled", "true")) === "true";
  const supportUsername = await getSetting("support_username", "SupportBot");
  const owner = await isOwner(id);
  const buttons: AnyRecord[][] = [
    [{ text: enabled ? "🔴 Disable Maintenance" : "🟢 Enable Maintenance", callback_data: `admin:maintenance:${enabled ? 0 : 1}` }],
    [{ text: referralsEnabled ? "🔴 Pause Referrals" : "🟢 Enable Referrals", callback_data: `admin:referrals:${referralsEnabled ? 0 : 1}` }],
    [{ text: "💬 Edit Support Bot", callback_data: "admin:editsupport" }],
    [{ text: "📝 Content Management", callback_data: "admin:content" }],
  ];
  if (owner) {
    buttons.push([{ text: "👮 Admin Management", callback_data: "admin:admins" }]);
  }
  buttons.push([{ text: "⬅️ Back", callback_data: "admin:home" }]);
  await edit(
    id,
    messageId,
    `🛠️ <b>BOT SETTINGS</b>\n\n` +
      `Maintenance mode: ${enabled ? "🟢 Enabled" : "🔴 Disabled"}\n` +
      `Referral program: ${referralsEnabled ? "🟢 Enabled" : "🔴 Paused"}\n` +
      `Support Bot: <code>${html(supportUsername)}</code>\n` +
      `Support link: <code>${html(supportLink(supportUsername))}</code>`,
    inline(...buttons),
    "HTML",
  );
}

async function adminAdmins(id: number, messageId: number) {
  if (!(await isOwner(id))) {
    await send(id, "🚫 Only the owner can manage admins.");
    return;
  }
  const rows = await adminList();
  let text = "👮 <b>ADMIN MANAGEMENT</b>\n\nAdmins have the same bot-management permissions as the owner. Only the owner can add or remove admins.\n\n";
  for (const row of rows) text += `👤 <code>${row.telegram_id}</code> · ${html(row.role)}\n`;
  const buttons: AnyRecord[][] = [];
  buttons.push([{ text: "➕ Add Admin", callback_data: "admin:addadmin" }]);
  buttons.push([{ text: "🗑️ Remove Admin", callback_data: "admin:removeadmin" }]);
  buttons.push([{ text: "⬅️ Back", callback_data: "admin:home" }]);
  await edit(id, messageId, text, inline(...buttons), "HTML");
}

async function adminUsers(id: number, messageId: number) {
  const rows = await userRows();
  const text = `👥 <b>USER MANAGEMENT</b>\n\n${rows.map((row) => `👤 <code>${row.telegram_id}</code> · ${html(row.username ? `@${row.username}` : row.first_name)} · 💎 ${row.points} · ${row.banned ? "🔨 Banned" : "🟢 Active"}`).join("\n") || "No users yet."}`;
  await edit(id, messageId, text, inline([{ text: "🔎 Search User ID", callback_data: "admin:searchuser" }], [{ text: "⬅️ Back", callback_data: "admin:home" }]), "HTML");
}

async function adminUserLookup(id: number, target: number, messageId?: number) {
  const result = await profile(target);
  if (!result.user) {
    const markup = inline([{ text: "🔎 Search Another User", callback_data: "admin:lookup" }], [{ text: "⬅️ Admin Panel", callback_data: "admin:home" }]);
    if (messageId) await edit(id, messageId, "❌ <b>User not found.</b>\n\nCheck the Telegram User ID and try again.", markup, "HTML");
    else await send(id, "❌ <b>User not found.</b>\n\nCheck the Telegram User ID and try again.", markup, "HTML");
    return;
  }
  const rewardsSummary =
    result.rewards.length > 0
      ? result.rewards
          .slice(-4)
          .map((reward) => `• ${html(reward.product_name)} · ${reward.status === "claimed" ? "✅ Claimed" : "🟢 Unlocked"}`)
          .join("\n")
      : "No rewards yet.";
  const text =
    `🔎 <b>USER LOOKUP</b>\n\n` +
    `👤 <b>${html(result.user.first_name || "Unnamed user")}</b>\n` +
    `🆔 Telegram ID: <code>${target}</code>\n` +
    `🔗 Username: ${result.user.username ? `@${html(result.user.username)}` : "—"}\n` +
    `📅 Joined: ${prettyDate(result.user.joined_at)}\n` +
    `💎 Points: <b>${result.user.points ?? 0}</b>\n` +
    `👥 Referrals: <b>${result.stats.valid}</b> valid · ${result.stats.pending} pending\n` +
    `🎁 Claimed rewards: <b>${result.rewards.filter((reward) => reward.status === "claimed").length}</b>\n` +
    `🔐 Status: <b>${result.user.banned ? "Banned" : "Active"}</b>\n\n` +
    `<b>Recent rewards</b>\n${rewardsSummary}`;
  const markup = inline(
    [{ text: "💎 Adjust Points", callback_data: `admin:points:${target}` }],
    [{ text: "🔨 Ban User", callback_data: `admin:ban:${target}` }],
    [{ text: "🔄 Refresh", callback_data: `admin:lookup:${target}` }],
    [{ text: "⬅️ Admin Panel", callback_data: "admin:home" }],
  );
  if (messageId) await edit(id, messageId, text, markup, "HTML");
  else await send(id, text, markup, "HTML");
}

async function adminLowStock(id: number, messageId: number) {
  const rows = await adminProducts();
  const threshold = 5;
  const lowStock = rows.filter((row) => num(row.stock) <= threshold);
  let text = `📦 <b>LOW-STOCK MONITOR</b>\n\nProducts with <b>${threshold} or fewer</b> available coupon items:\n\n`;
  if (!lowStock.length) {
    text += "✅ All products have healthy stock levels.";
  } else {
    for (const row of lowStock) {
      text += `${num(row.stock) === 0 ? "🔴" : "🟠"} <b>${html(row.name)}</b> · ${row.stock} available${row.enabled ? "" : " · Disabled"}\n`;
    }
  }
  const buttons = lowStock.map((row) => [{ text: `🎁 ${row.name}`, callback_data: `admin:product:${row.id}` }]);
  buttons.push([{ text: "🔄 Refresh", callback_data: "admin:lowstock" }]);
  buttons.push([{ text: "⬅️ Admin Panel", callback_data: "admin:home" }]);
  await edit(id, messageId, text, inline(...buttons), "HTML");
}

async function adminBroadcast(id: number, messageId: number) {
  await edit(id, messageId, "📢 <b>BROADCAST STUDIO</b>\n\nSend text, photo, video, GIF, or document. You will see a preview and recipient count before anything is sent.", inline([{ text: "✏️ Compose Broadcast", callback_data: "admin:broadcastinput" }], [{ text: "⬅️ Back", callback_data: "admin:home" }]), "HTML");
}

async function adminDisclaimer(id: number, messageId: number) {
  const enabled = (await getSetting("disclaimer_enabled", "true")) === "true";
  const text = await getSetting("disclaimer", DEFAULT_DISCLAIMER);
  await edit(
    id,
    messageId,
    `⚠️ <b>DISCLAIMER CONTROL</b>\n\nStatus: ${enabled ? "🟢 Mandatory" : "🔴 Disabled"}\n\n<b>Current preview</b>\n${html(text.slice(0, 500))}${text.length > 500 ? "…" : ""}`,
    inline(
      [{ text: "✏️ Edit Disclaimer", callback_data: "admin:editcontent:disclaimer" }],
      [{ text: "👁️ Preview", callback_data: "admin:previewdisclaimer" }],
      [{ text: enabled ? "🔴 Disable" : "🟢 Enable", callback_data: `admin:toggle_disclaimer:${enabled ? 0 : 1}` }],
      [{ text: "↩️ Restore Default", callback_data: "admin:restore_disclaimer" }],
      [{ text: "⬅️ Back", callback_data: "admin:home" }],
    ),
    "HTML",
  );
}

async function adminAudit(id: number, messageId: number, offset = 0) {
  const rows = await auditRows(10, offset);
  let text = "📜 <b>AUDIT LOGS</b>\n\n";
  if (!rows.length) text += "No admin activity recorded yet.";
  for (const row of rows) {
    text += `🕘 ${prettyDate(row.created_at)}\n<b>${html(row.action)}</b> · <code>${html(row.target ?? "—")}</code>\n${html(row.details ?? "")}\n\n`;
  }
  const buttons: AnyRecord[][] = [];
  if (offset > 0) buttons.push([{ text: "◀️ Newer", callback_data: `admin:audit:${Math.max(0, offset - 10)}` }]);
  if (rows.length === 10) buttons.push([{ text: "Older ▶️", callback_data: `admin:audit:${offset + 10}` }]);
  buttons.push([{ text: "⬅️ Back", callback_data: "admin:home" }]);
  await edit(id, messageId, text, inline(...buttons), "HTML");
}

async function beginBroadcast(adminId: number, message: AnyRecord) {
  const jobId = await createBroadcast(adminId, num(message.message_id));
  await telegram("copyMessage", { chat_id: adminId, from_chat_id: adminId, message_id: message.message_id });
  await send(adminId, `📣 <b>BROADCAST PREVIEW</b>\n\n👥 Recipients: <b>${(await broadcastUsers()).length}</b>\n\nReview the message above, then choose an action.`, inline(
    [{ text: "📤 Send", callback_data: `broadcast:confirm:${jobId}` }],
    [{ text: "❌ Cancel", callback_data: `broadcast:cancel:${jobId}` }],
  ), "HTML");
}

async function runBroadcast(adminId: number, jobId: number) {
  const job = await broadcastJob(jobId);
  if (!job) return;
  await setBroadcastStatus(jobId, "sending");
  let sent = num(job.sent);
  let failed = num(job.failed);
  let last = num(job.last_user_id);
  const users = await broadcastUsers(last);
  const progressMessage = await send(
    adminId,
    `📣 <b>Broadcasting…</b>\n\n${spinnerFrames[0]} Preparing recipients\n${progressBar(0, users.length)}\n\n✅ Sent: 0\n❌ Failed: 0\n⏳ Remaining: ${users.length}`,
    undefined,
    "HTML",
  );
  const progressMessageId = num(progressMessage?.message_id);
  for (const userId of users) {
    try {
      await telegram("copyMessage", { chat_id: userId, from_chat_id: job.source_chat_id, message_id: job.source_message_id });
      sent += 1;
    } catch (error) {
      const response = (error as AnyRecord).response;
      if (response?.parameters?.retry_after) {
        await new Promise((resolve) => setTimeout(resolve, Number(response.parameters.retry_after) * 1000));
        try {
          await telegram("copyMessage", { chat_id: userId, from_chat_id: job.source_chat_id, message_id: job.source_message_id });
          sent += 1;
        } catch {
          failed += 1;
        }
      } else failed += 1;
    }
    last = userId;
    await broadcastProgress(jobId, last, sent, failed);
    if ((sent + failed) % 25 === 0) {
      const done = sent + failed;
      await edit(
        adminId,
        progressMessageId,
        `📣 <b>Broadcasting…</b>\n\n${spinnerFrames[(done / 25) % spinnerFrames.length | 0]} Working\n${progressBar(done, users.length)}\n\n✅ Sent: ${sent}\n❌ Failed: ${failed}\n⏳ Remaining: ${Math.max(0, users.length - done)}`,
        undefined,
        "HTML",
      ).catch(() => undefined);
    }
  }
  await setBroadcastStatus(jobId, "done");
  await edit(adminId, progressMessageId, `✅ <b>Broadcast complete</b>\n\n${progressBar(sent + failed, users.length)}\n\n✅ Sent: ${sent}\n❌ Failed: ${failed}`, inline([{ text: "⬅️ Admin Panel", callback_data: "admin:home" }]), "HTML").catch(() => undefined);
}

async function adminInput(id: number, message: AnyRecord, state: AnyRecord) {
  const text = String(message.text ?? "").trim();
  if (state.kind === "productName") {
    if (text.length < 2 || text.length > 120) return send(id, "Send a product name between 2 and 120 characters.");
    adminStates.set(id, { kind: "productPoints", name: text });
    return send(id, "2️⃣ Required points? Send a whole number.");
  }
  if (state.kind === "productPoints") {
    const points = Number(text);
    if (!Number.isInteger(points) || points < 0) return send(id, "Send a valid non-negative whole number.");
    adminStates.set(id, { kind: "productHowToUse", name: state.name, points });
    return send(id, "3️⃣ Send the How to Use message for this product. You can include steps, a link, or any instructions. Send - to leave it empty.");
  }
  if (state.kind === "productHowToUse") {
    if (text.length > 4000) return send(id, "Keep the How to Use message under 4,000 characters.");
    adminStates.set(id, {
      kind: "productCode",
      name: state.name,
      points: state.points,
      howToUse: text === "-" ? "" : text,
    });
    return send(id, "4️⃣ Send one coupon item. Plain code, link, or JSON are all allowed. Add each item separately.");
  }
  if (state.kind === "productCode") {
    if (!text) return send(id, "Send one coupon code, link, or JSON item.");
    adminStates.set(id, { ...state, kind: "productConfirm", code: text });
    return send(id, `✅ Preview\n\n🎁 ${state.name}\n💎 Points: ${state.points}\n📖 How to use: ${state.howToUse || "Not configured"}\n📦 Stock: 1`, inline([{ text: "✅ Confirm Product", callback_data: "admin:confirmproduct" }], [{ text: "❌ Cancel", callback_data: "admin:cancelinput" }]));
  }
  if (state.kind === "stockCode") {
    if (!text) return send(id, "Send one coupon code, link, or JSON item.");
    adminStates.set(id, { ...state, kind: "stockConfirm", code: text });
    return send(id, "📦 Add this one coupon item?", inline([{ text: "✅ Confirm", callback_data: "admin:confirmstock" }], [{ text: "❌ Cancel", callback_data: "admin:cancelinput" }]));
  }
  if (state.kind === "productHowToUseEdit") {
    if (text.length > 4000) return send(id, "Keep the How to Use message under 4,000 characters.");
    const howToUse = text === "-" ? "" : text;
    await setProduct(state.productId, { howToUse });
    await audit(id, "product_how_to_use_update", String(state.productId));
    adminStates.delete(id);
    return send(id, "✅ How to Use message updated.", inline([{ text: "📖 How to Use", callback_data: `admin:howto:${state.productId}` }], [{ text: "⬅️ Stock Management", callback_data: "admin:stock" }]));
  }
  if (state.kind === "milestoneRefs") {
    const refs = Number(text);
    if (!Number.isInteger(refs) || refs < 1) return send(id, "Send a positive whole number.");
    adminStates.set(id, { kind: "milestoneProduct", refs });
    const rows = await adminProducts();
    return send(id, "Select the reward product.", inline(...rows.map((row) => [{ text: row.name, callback_data: `admin:selectmilestoneproduct:${row.id}` }]), [{ text: "❌ Cancel", callback_data: "admin:cancelinput" }]));
  }
  if (state.kind === "channel") {
    const [chatId, title, link] = text.split("|").map((value) => value.trim());
    if (!chatId || !title || !link) return send(id, "Format: channel_id | title | invite_link");
    await addChannel(chatId, title, link);
    await audit(id, "channel_add", chatId, title);
    adminStates.delete(id);
    return send(id, "✅ Channel added.", inline([{ text: "📢 Force Subscribe", callback_data: "admin:channels" }]));
  }
  if (state.kind === "content") {
    await setSetting(state.key, text);
    await audit(id, "content_update", state.key);
    adminStates.delete(id);
    return send(id, "✅ Content updated.", inline([{ text: "📝 Content Management", callback_data: "admin:content" }]));
  }
  if (state.kind === "supportUsername") {
    const normalized = text
      .replace(/^https?:\/\/t\.me\//i, "")
      .replace(/^@/, "")
      .replace(/\/+$/, "");
    if (!/^[A-Za-z0-9_]{3,64}$/.test(normalized)) {
      return send(id, "Send a valid Telegram bot username such as <code>@SupportBot</code> or <code>https://t.me/SupportBot</code>.", undefined, "HTML");
    }
    await setSetting("support_username", normalized);
    await audit(id, "support_bot_update", normalized);
    adminStates.delete(id);
    return send(id, `✅ Support Bot updated.\n\n🔗 <code>${html(supportLink(normalized))}</code>`, inline([{ text: "🛠️ Bot Settings", callback_data: "admin:settings" }]), "HTML");
  }
  if (state.kind === "pointsUserId") {
    const target = Number(text);
    if (!Number.isSafeInteger(target) || target <= 0) return send(id, "Send a valid Telegram User ID.");
    const user = await userById(target);
    if (!user) return send(id, "User not found. Send a registered Telegram User ID.");
    adminStates.set(id, { kind: "pointsAmount", target, currentPoints: num(user.points) });
    return send(
      id,
      `💎 <b>POINTS MANAGER</b>\n\nUser <code>${target}</code> currently has <b>${user.points}</b> points.\n\nSend the adjustment amount:\n• <b>Positive</b> number adds points, for example <code>50</code>\n• <b>Negative</b> number deducts points, for example <code>-25</code>`,
      inline([{ text: "❌ Cancel", callback_data: "admin:cancelinput" }]),
      "HTML",
    );
  }
  if (state.kind === "pointsAmount") {
    const delta = Number(text);
    if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 1_000_000) {
      return send(id, "Send a whole number between -1,000,000 and 1,000,000, excluding zero.");
    }
    const updatedPoints = await adjustPoints(state.target, delta);
    if (updatedPoints === null) {
      adminStates.delete(id);
      return send(id, "❌ User no longer exists. Start again from Points Manager.");
    }
    await audit(
      id,
      delta > 0 ? "points_add" : "points_deduct",
      String(state.target),
      `${delta > 0 ? "+" : ""}${delta} points · ${state.currentPoints} → ${updatedPoints}`,
    );
    adminStates.delete(id);
    return send(
      id,
      `✅ <b>Points updated</b>\n\nUser: <code>${state.target}</code>\nAdjustment: <b>${delta > 0 ? "+" : ""}${delta}</b>\nNew balance: <b>${updatedPoints} points</b>`,
      inline(
        [{ text: "🔎 View User", callback_data: `admin:lookup:${state.target}` }],
        [{ text: "💎 Adjust Another", callback_data: "admin:points" }],
        [{ text: "⬅️ Admin Panel", callback_data: "admin:home" }],
      ),
      "HTML",
    );
  }
  if (state.kind === "userLookup") {
    const target = Number(text);
    if (!Number.isSafeInteger(target) || target <= 0) return send(id, "Send a valid Telegram User ID.");
    adminStates.delete(id);
    return adminUserLookup(id, target);
  }
  if (state.kind === "userSearch") {
    const target = Number(text);
    if (!Number.isSafeInteger(target) || !(await userById(target))) return send(id, "User not found. Send a valid Telegram User ID.");
    adminStates.delete(id);
    const result = await profile(target);
    return send(id, `👤 User Profile\n\nID: ${target}\nPoints: ${result.user?.points}\nValid referrals: ${result.stats.valid}\nBanned: ${result.user?.banned ? "Yes" : "No"}`, inline([{ text: "➕ Add 1 Point", callback_data: `admin:addpoint:${target}` }, { text: "🔨 Ban", callback_data: `admin:ban:${target}` }], [{ text: "⬅️ Back", callback_data: "admin:users" }]));
  }
  if (state.kind === "adminAdd") {
    if (!(await isOwner(id))) {
      adminStates.delete(id);
      return send(id, "🚫 Only the owner can add admins.");
    }
    const target = Number(text);
    if (!Number.isSafeInteger(target) || target <= 0) return send(id, "Send a valid Telegram User ID.");
    if (await isOwner(target)) {
      adminStates.delete(id);
      return send(id, "That ID is already the owner.");
    }
    const added = await addAdmin(target, id);
    await audit(id, "admin_add", String(target));
    adminStates.delete(id);
    return send(
      id,
      added ? "✅ Admin added with full admin permissions." : "ℹ️ That user is already an admin.",
      inline([{ text: "👮 Admin Management", callback_data: "admin:admins" }]),
    );
  }
  if (state.kind === "adminRemove") {
    if (!(await isOwner(id))) {
      adminStates.delete(id);
      return send(id, "🚫 Only the owner can remove admins.");
    }
    const target = Number(text);
    if (!Number.isSafeInteger(target) || target <= 0 || (await isOwner(target))) return send(id, "That owner ID cannot be removed.");
    const removed = await removeAdmin(target);
    await audit(id, "admin_remove", String(target));
    adminStates.delete(id);
    return send(
      id,
      removed ? "✅ Admin removed." : "ℹ️ That user was not an admin.",
      inline([{ text: "👮 Admin Management", callback_data: "admin:admins" }]),
    );
  }
  if (state.kind === "broadcastMessage") return beginBroadcast(id, message);
  return send(id, "Use the Admin Panel buttons to continue.");
}

async function adminCallback(query: AnyRecord) {
  const id = num(query.from?.id);
  if (!(await isAdmin(id))) {
    await callback(query.id, "Access denied");
    await send(id, "🚫 Access denied.");
    return;
  }
  await callback(query.id);
  const data = String(query.data);
  const messageId = num(query.message?.message_id);
  if (data === "admin:home") return adminPanel(id, messageId);
  if (data === "admin:dashboard") return adminDashboard(id, messageId);
  if (data === "admin:stock") return adminStock(id, messageId);
  if (data === "admin:milestones") return adminMilestones(id, messageId);
  if (data === "admin:channels") return adminChannels(id, messageId);
  if (data === "admin:content") return adminContent(id, messageId);
  if (data === "admin:settings") return adminSettings(id, messageId);
  if (data === "admin:admins") return adminAdmins(id, messageId);
  if (data === "admin:users") return adminUsers(id, messageId);
  if (data === "admin:lowstock") return adminLowStock(id, messageId);
  if (data === "admin:points") {
    adminStates.set(id, { kind: "pointsUserId" });
    return send(id, "💎 <b>POINTS MANAGER</b>\n\nEnter the Telegram User ID whose points you want to change.", undefined, "HTML");
  }
  if (data.startsWith("admin:points:")) {
    const target = num(data.split(":")[2]);
    const user = await userById(target);
    if (!user) return send(id, "❌ User not found.", inline([{ text: "💎 Points Manager", callback_data: "admin:points" }]));
    adminStates.set(id, { kind: "pointsAmount", target, currentPoints: num(user.points) });
    return send(
      id,
      `💎 <b>POINTS MANAGER</b>\n\nUser <code>${target}</code> currently has <b>${user.points}</b> points.\n\nSend a positive number to add points or a negative number to deduct points.`,
      inline([{ text: "❌ Cancel", callback_data: "admin:cancelinput" }]),
      "HTML",
    );
  }
  if (data === "admin:lookup") {
    adminStates.set(id, { kind: "userLookup" });
    return send(id, "🔎 <b>USER LOOKUP</b>\n\nEnter a registered Telegram User ID.", undefined, "HTML");
  }
  if (data.startsWith("admin:lookup:")) return adminUserLookup(id, num(data.split(":")[2]), messageId);
  if (data === "admin:broadcast") return adminBroadcast(id, messageId);
  if (data === "admin:disclaimer") return adminDisclaimer(id, messageId);
  if (data === "admin:audit") return adminAudit(id, messageId);
  if (data.startsWith("admin:audit:")) return adminAudit(id, messageId, num(data.split(":")[2]));
  if (data === "admin:previewdisclaimer") {
    const disclaimer = await getSetting("disclaimer", DEFAULT_DISCLAIMER);
    return send(id, `⚠️ <b>DISCLAIMER PREVIEW</b>\n\n${html(disclaimer)}`, inline([{ text: "⚠️ Disclaimer Control", callback_data: "admin:disclaimer" }]), "HTML");
  }
  if (data.startsWith("admin:previewcontent:")) {
    const key = data.split(":")[2];
    const labels: Record<string, string> = {
      welcome: "WELCOME PREVIEW",
      disclaimer: "DISCLAIMER PREVIEW",
      support_message: "SUPPORT MESSAGE PREVIEW",
      maintenance_message: "MAINTENANCE MESSAGE PREVIEW",
    };
    const value = await getSetting(key, key === "disclaimer" ? DEFAULT_DISCLAIMER : "");
    return send(
      id,
      `👁️ <b>${labels[key] ?? "CONTENT PREVIEW"}</b>\n\n${html(value)}`,
      inline([{ text: "📝 Content Management", callback_data: "admin:content" }]),
      "HTML",
    );
  }
  if (data.startsWith("admin:toggle_disclaimer:")) {
    const enabled = data.split(":")[2] === "1";
    await setSetting("disclaimer_enabled", String(enabled));
    await audit(id, "disclaimer_toggle", String(enabled));
    return adminDisclaimer(id, messageId);
  }
  if (data === "admin:restore_disclaimer") {
    await setSetting("disclaimer", DEFAULT_DISCLAIMER);
    await audit(id, "disclaimer_restore");
    return adminDisclaimer(id, messageId);
  }
  if (data === "admin:addproduct") {
    adminStates.set(id, { kind: "productName" });
    return send(id, "1️⃣ Product name?");
  }
  if (data === "admin:confirmproduct") {
    const state = adminStates.get(id);
    if (!state || state.kind !== "productConfirm") return send(id, "❌ This input session expired.");
    const productId = await addProduct(state.name, state.points, state.howToUse, state.code);
    await audit(id, "product_create", String(productId), "1 coupon item");
    adminStates.delete(id);
    return send(id, `✅ Product Added\n\n🎁 Product: ${state.name}\n💎 Points: ${state.points}\n📖 How to use: ${state.howToUse || "Not configured"}\n📦 Stock: 1`, inline([{ text: "🎁 Stock Management", callback_data: "admin:stock" }]));
  }
  if (data === "admin:addstock") {
    const rows = await adminProducts();
    return send(id, "Select a product.", inline(...rows.map((row) => [{ text: row.name, callback_data: `admin:addstock:${row.id}` }]), [{ text: "❌ Cancel", callback_data: "admin:cancelinput" }]));
  }
  if (data.startsWith("admin:addstock:")) {
    const productId = num(data.split(":")[2]);
    adminStates.set(id, { kind: "stockCode", productId });
    return send(id, "Send one coupon item. Plain code, link, or JSON are all allowed. Add each item separately.");
  }
  if (data === "admin:confirmstock") {
    const state = adminStates.get(id);
    if (!state || state.kind !== "stockConfirm") return send(id, "❌ This input session expired.");
    const stock = await addStock(state.productId, state.code);
    await audit(id, "stock_add", String(state.productId), "1 coupon item");
    adminStates.delete(id);
    return send(id, `✅ Stock updated.\n📦 Available: ${stock}`, inline([{ text: "🎁 Stock Management", callback_data: "admin:stock" }]));
  }
  if (data.startsWith("admin:howto:")) {
    const productId = num(data.split(":")[2]);
    const row = await product(productId);
    if (!row) return send(id, "❌ Product not found.", inline([{ text: "⬅️ Stock Management", callback_data: "admin:stock" }]));
    return send(
      id,
      `📖 <b>HOW TO USE · ${html(row.name)}</b>\n\n${row.how_to_use ? html(row.how_to_use) : "No How to Use message configured yet."}`,
      inline([{ text: "✏️ Edit How to Use", callback_data: `admin:edithowto:${productId}` }], [{ text: "⬅️ Product", callback_data: `admin:product:${productId}` }]),
      "HTML",
    );
  }
  if (data.startsWith("admin:edithowto:")) {
    const productId = num(data.split(":")[2]);
    const row = await product(productId);
    if (!row) return send(id, "❌ Product not found.", inline([{ text: "⬅️ Stock Management", callback_data: "admin:stock" }]));
    adminStates.set(id, { kind: "productHowToUseEdit", productId });
    return send(id, `Send the How to Use message for <b>${html(row.name)}</b>.\n\nYou can include steps, links, or any instructions. Send - to clear it.`, undefined, "HTML");
  }
  if (data.startsWith("admin:product:")) return adminProduct(id, messageId, num(data.split(":")[2]));
  if (data.startsWith("admin:toggleproduct:")) {
    const productId = num(data.split(":")[2]);
    const row = await product(productId);
    if (row) await setProduct(productId, { enabled: !row.enabled });
    await audit(id, "product_toggle", String(productId));
    return adminProduct(id, messageId, productId);
  }
  if (data.startsWith("admin:deleteproduct:")) {
    const productId = num(data.split(":")[2]);
    await deleteProduct(productId);
    await audit(id, "product_delete", String(productId));
    return adminStock(id, messageId);
  }
  if (data === "admin:addmilestone") {
    adminStates.set(id, { kind: "milestoneRefs" });
    return send(id, "Required valid referrals?");
  }
  if (data.startsWith("admin:selectmilestoneproduct:")) {
    const state = adminStates.get(id);
    if (!state || state.kind !== "milestoneProduct") return send(id, "❌ This input session expired.");
    const milestoneId = await addMilestone(state.refs, num(data.split(":")[3]));
    await audit(id, "milestone_add", String(milestoneId), `${state.refs} referrals`);
    adminStates.delete(id);
    return send(id, "✅ Milestone added.", inline([{ text: "🎯 Milestones", callback_data: "admin:milestones" }]));
  }
  if (data.startsWith("admin:togglemilestone:")) {
    const [, , , milestoneId, enabled] = data.split(":");
    await setMilestone(num(milestoneId), enabled === "1");
    await audit(id, "milestone_toggle", milestoneId);
    return adminMilestones(id, messageId);
  }
  if (data === "admin:addchannel") {
    adminStates.set(id, { kind: "channel" });
    return send(id, "Send: channel_id | title | invite_link");
  }
  if (data.startsWith("admin:deletechannel:")) {
    await removeChannel(num(data.split(":")[2]));
    await audit(id, "channel_delete", data.split(":")[2]);
    return adminChannels(id, messageId);
  }
  if (data.startsWith("admin:editcontent:")) {
    const key = data.split(":")[2];
    adminStates.set(id, { kind: "content", key });
    return send(id, `Send the new ${key} content.`);
  }
  if (data.startsWith("admin:maintenance:")) {
    const enabled = data.split(":")[2] === "1";
    await setSetting("maintenance_enabled", String(enabled));
    await audit(id, "maintenance", String(enabled));
    return adminSettings(id, messageId);
  }
  if (data.startsWith("admin:referrals:")) {
    const enabled = data.split(":")[2] === "1";
    await setSetting("referrals_enabled", String(enabled));
    await audit(id, "referrals_toggle", String(enabled));
    return adminSettings(id, messageId);
  }
  if (data === "admin:editsupport") {
    adminStates.set(id, { kind: "supportUsername" });
    return send(
      id,
      "💬 <b>SUPPORT BOT SETUP</b>\n\nSend the support bot username or Telegram URL.\nExamples:\n<code>@SupportBot</code>\n<code>https://t.me/SupportBot</code>",
      undefined,
      "HTML",
    );
  }
  if (data === "admin:searchuser") {
    adminStates.set(id, { kind: "userSearch" });
    return send(id, "Send Telegram User ID.");
  }
  if (data.startsWith("admin:addpoint:")) {
    const target = num(data.split(":")[2]);
    const updatedPoints = await adjustPoints(target, 1);
    await audit(id, "points_add", String(target), "1");
    return send(id, `✅ Point added.\n💎 New balance: ${updatedPoints ?? "—"}`, inline([{ text: "🔎 User Lookup", callback_data: `admin:lookup:${target}` }]));
  }
  if (data.startsWith("admin:ban:")) {
    const target = num(data.split(":")[2]);
    await adjustUser(target, 0, true);
    await audit(id, "user_ban", String(target));
    return send(id, "✅ User banned.", inline([{ text: "👥 User Management", callback_data: "admin:users" }]));
  }
  if (data === "admin:addadmin") {
    if (!(await isOwner(id))) return send(id, "🚫 Only the owner can add admins.");
    adminStates.set(id, { kind: "adminAdd" });
    return send(
      id,
      "➕ <b>ADD ADMIN</b>\n\nSend the Telegram User ID to add.\nThis grants the same bot-management permissions as the owner, but the new admin cannot add or remove admins.",
      inline([{ text: "❌ Cancel", callback_data: "admin:cancelinput" }]),
      "HTML",
    );
  }
  if (data === "admin:removeadmin") {
    if (!(await isOwner(id))) return send(id, "🚫 Only the owner can remove admins.");
    adminStates.set(id, { kind: "adminRemove" });
    return send(
      id,
      "🗑️ <b>REMOVE ADMIN</b>\n\nSend the Telegram User ID to remove. The owner ID can never be removed.",
      inline([{ text: "❌ Cancel", callback_data: "admin:cancelinput" }]),
      "HTML",
    );
  }
  if (data === "admin:broadcastinput") {
    adminStates.set(id, { kind: "broadcastMessage" });
    return send(id, "Send the broadcast content now.");
  }
  if (data === "admin:cancelinput") {
    adminStates.delete(id);
    return send(id, "❌ Cancelled.", inline([{ text: "⚙️ Admin Panel", callback_data: "admin:home" }]));
  }
  if (data.startsWith("broadcast:confirm:")) {
    const jobId = num(data.split(":")[2]);
    await audit(id, "broadcast_start", String(jobId));
    await runBroadcast(id, jobId);
    return;
  }
  if (data.startsWith("broadcast:cancel:")) {
    const jobId = num(data.split(":")[2]);
    await setBroadcastStatus(jobId, "cancelled");
    await audit(id, "broadcast_cancel", String(jobId));
    return send(id, "❌ Broadcast cancelled.", inline([{ text: "⚙️ Admin Panel", callback_data: "admin:home" }]));
  }
}

async function handleCallback(query: AnyRecord) {
  const id = num(query.from?.id);
  const data = String(query.data ?? "");
  await callback(query.id);
  if (data.startsWith("admin:") || data.startsWith("broadcast:")) return adminCallback(query);
  if (!(await protectedUser(id))) return;
  const messageId = num(query.message?.message_id);
  if (data === "home" || data === "home_menu") return showHome(id, messageId);
  if (data === "check_sub") {
    if (!(await checkSubscriptions(id))) {
      return edit(id, messageId, "❌ Please join ALL required channels first, then tap Check Subscription.", inline([{ text: "🔄 Check Subscription", callback_data: "check_sub" }]));
    }
    await markStatus(id, "subscribed");
    return showDisclaimer(id, messageId);
  }
  if (data === "accept_disclaimer") {
    await markStatus(id, "disclaimer_accepted", true);
    return showStartUsing(id, messageId);
  }
  if (data === "start_using") return startUsing(id, messageId);
  if (data === "home_referral") return showReferral(id);
  if (data === "home_rewards") return showRewards(id);
  if (data.startsWith("stock:")) return showStock(id, num(data.split(":")[1]), messageId);
  if (data.startsWith("product:")) return showProduct(id, num(data.split(":")[1]), messageId);
  if (data.startsWith("claim:")) return claimProduct(id, num(data.split(":")[1]));
  if (data.startsWith("reward:")) return claimReward(id, num(data.split(":")[1]));
}

async function handleMessage(message: AnyRecord) {
  const id = num(message.from?.id);
  if (!id) return;
  if (message.text?.startsWith("/start")) return safe(() => startOnboarding(message), id);
  if (message.text === "/admin") return safe(() => adminPanel(id), id);
  if ((await isAdmin(id)) && adminStates.has(id)) {
    const state = adminStates.get(id);
    if (state) return safe(() => adminInput(id, message, state), id);
  }
  if (!(await protectedUser(id))) return;
  const text = String(message.text ?? "");
  if (text === "👥 Refer & Earn") return safe(() => showReferral(id), id);
  if (text === "🎁 Browse Rewards" || text === "🎁 Stock") return safe(() => showStock(id), id);
  if (text === "🏆 My Rewards" || text === "🎁 My Rewards") return safe(() => showRewards(id), id);
  if (text === "👤 Profile" || text === "👤 My Profile") return safe(() => showProfile(id), id);
  if (text === "📘 How It Works" || text === "ℹ️ How It Works") return safe(() => showHow(id), id);
  if (text === "💬 Support") return safe(() => showSupport(id), id);
  if (text === "⚙️ Admin Panel") return safe(() => adminPanel(id), id);
  await showHome(id);
}

export async function startBot() {
  const me = await telegram("getMe");
  botUsername = me.username;
  await telegram("deleteWebhook", { drop_pending_updates: false });
  for (const job of await pendingBroadcasts()) {
    runBroadcast(num(job.source_chat_id), num(job.id)).catch((error) => console.error("broadcast resume failed", error));
  }
  let offset = 0;
  console.info(`Free Coupon Hub started as @${botUsername}`);
  while (true) {
    try {
      const updates = (await telegram("getUpdates", { offset, timeout: 25, allowed_updates: ["message", "callback_query"] })) as AnyRecord[];
      for (const update of updates) {
        offset = num(update.update_id) + 1;
        if (update.callback_query) await safe(() => handleCallback(update.callback_query), num(update.callback_query.from?.id));
        else if (update.message) await handleMessage(update.message);
      }
    } catch (error) {
      console.error("polling error", error);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}