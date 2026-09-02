import { describe, expect, test } from "bun:test";
import { resolveTelegramUploadTarget } from "./upload-telegram";

describe("resolveTelegramUploadTarget", () => {
  test("uses the forum topic when group + topic id are set", () => {
    expect(
      resolveTelegramUploadTarget({
        dmChatId: "111",
        groupChatId: "-1001234567890",
        telegramTopicId: 25,
      }),
    ).toEqual({
      chatId: "-1001234567890",
      messageThreadId: 25,
      label: "group -1001234567890 topic 25",
    });
  });

  test("falls back to DM when topic is missing", () => {
    expect(
      resolveTelegramUploadTarget({
        dmChatId: "111",
        groupChatId: "-1001234567890",
        telegramTopicId: null,
      }),
    ).toEqual({ chatId: "111", label: "DM 111" });
  });

  test("falls back to DM when group chat id is missing", () => {
    expect(
      resolveTelegramUploadTarget({
        dmChatId: "111",
        telegramTopicId: 25,
      }),
    ).toEqual({ chatId: "111", label: "DM 111" });
  });

  test("does not send to General (topic 1)", () => {
    expect(
      resolveTelegramUploadTarget({
        dmChatId: "111",
        groupChatId: "-1001234567890",
        telegramTopicId: 1,
      }),
    ).toEqual({ chatId: "111", label: "DM 111" });
  });
});
