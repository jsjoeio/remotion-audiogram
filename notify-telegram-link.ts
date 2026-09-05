/**
 * Post a public podcast AAC URL to the client's Telegram topic (or DM).
 * Same targeting rules as uploadVideoToTelegram (topic when mapped).
 */

import {
  GENERAL_TOPIC_ID,
  resolveTelegramUploadTarget,
} from "./upload-telegram";
import type { PodcastMeta } from "./r2-podcast";

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `Missing ${name}. Needed to post the public audio link to Telegram.`,
    );
  }
  return value;
}

export type SendLinkResult = {
  messageId?: number;
  chatId: string;
  messageThreadId?: number;
};

/**
 * sendMessage with the public HTTPS URL so Joe can copy it from the topic.
 */
export async function sendPublicAudioLinkToTelegram(options: {
  publicUrl: string;
  meta: PodcastMeta;
}): Promise<SendLinkResult> {
  const token = requireEnv("TELEGRAM_BOT_TOKEN");
  const dmChatId = requireEnv("ALLOWED_TELEGRAM_USER_ID");
  const groupChatId = process.env.TELEGRAM_GROUP_CHAT_ID?.trim() || "";
  const { publicUrl, meta } = options;

  if (
    meta.telegramTopicId != null &&
    meta.telegramTopicId > GENERAL_TOPIC_ID &&
    !groupChatId
  ) {
    console.warn(
      "   telegramTopicId is set but TELEGRAM_GROUP_CHAT_ID is missing — falling back to DM.",
    );
  }

  const target = resolveTelegramUploadTarget({
    dmChatId,
    groupChatId,
    telegramTopicId: meta.telegramTopicId,
  });

  const title = `${meta.clientFullName} - ${meta.podcastTitle}`;
  const text =
    `🎙️ ${title}\n\n` +
    `${publicUrl}\n\n` +
    `Paste into app.jsjoe.io/program/compose → Podcast URL`;

  console.log("\n📤 Post public audio link to Telegram");
  console.log(`   Chat: ${target.label}`);
  console.log(`   URL:  ${publicUrl}`);

  const body: Record<string, string | number> = {
    chat_id: target.chatId,
    text,
    disable_web_page_preview: false,
  };
  if (target.messageThreadId != null) {
    body.message_thread_id = target.messageThreadId;
  }

  const res = await fetch(
    `https://api.telegram.org/bot${token}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  const json = (await res.json()) as {
    ok: boolean;
    description?: string;
    result?: { message_id?: number };
  };
  if (!json.ok) {
    throw new Error(
      `Telegram sendMessage failed: ${json.description ?? "unknown"}`,
    );
  }

  console.log(
    `✅ Link posted${json.result?.message_id != null ? ` (message_id ${json.result.message_id})` : ""}`,
  );
  console.log(
    target.messageThreadId != null
      ? "   Check the client's topic in the coaching group."
      : "   Check your DM with the bot.",
  );

  return {
    messageId: json.result?.message_id,
    chatId: target.chatId,
    messageThreadId: target.messageThreadId,
  };
}
