/**
 * shell(voc/tbvoc) 與 of 共用的 config 安全閘／組裝水電。
 *
 * 這裡只收與 target 資料模型無關的規則；各自的 Config shape、Google 分頁欄位與
 * shell-only target 仍由呼叫端提供。
 */
import dotenv from "dotenv";
import {
  boolEnv,
  chatIdsEnv,
  enumEnv,
  optional,
  required,
  logger,
} from "@pei760730/collector-core";

// .env 必須蓋過 Windows 可能殘留的系統環境變數；dotenv v17 的 tip 不進 CI/drain log。
dotenv.config({ override: true, quiet: true });

export { chatIdsEnv };

export type StorageMode = "sheets" | "memory";

export interface SharedConfig<GoogleConfig> {
  telegramToken: string;
  storage: StorageMode;
  google: GoogleConfig | null;
  errorChatId: string;
  allowedChatIds: number[];
  expandShortUrls: boolean;
  logLevel: string;
}

export interface ConfigLoaderOptions<GoogleConfig, Extension extends object> {
  /** fail-fast 訊息中的實際寫入目的地；只影響既有 target-specific 文案。 */
  sheetsDestination: string;
  /** 只在 sheets 模式呼叫，Google config shape 由各 target 自己決定。 */
  loadGoogleConfig: () => GoogleConfig;
  /** shell-only target 等額外頂層欄位；of 不需提供。 */
  loadExtension?: () => Extension;
}

/**
 * 建立每個 config module 自己的 cached loader。
 *
 * cache 刻意留在 factory closure，而非 shared module 全域，避免同一進程先後載入
 * shell/of 時互相拿到另一個 target 的 Config。
 */
export function createConfigLoader<
  GoogleConfig,
  Extension extends object = Record<never, never>,
>(
  options: ConfigLoaderOptions<GoogleConfig, Extension>,
): () => SharedConfig<GoogleConfig> & Extension {
  let cached: (SharedConfig<GoogleConfig> & Extension) | null = null;

  return () => {
    if (cached) return cached;

    const storage = enumEnv("STORAGE", ["sheets", "memory"] as const, "sheets");
    const google = storage === "memory" ? null : options.loadGoogleConfig();
    const extension = options.loadExtension?.() ?? ({} as Extension);

    // 指派時機維持既有 loadConfig：先組出 cached，再執行 fail-fast / warn guard。
    cached = {
      ...extension,
      telegramToken: required("TELEGRAM_BOT_TOKEN"),
      storage,
      google,
      errorChatId: optional("ERROR_CHAT_ID", ""),
      allowedChatIds: chatIdsEnv("ALLOWED_CHAT_IDS"),
      expandShortUrls: boolEnv("EXPAND_SHORT_URLS", false),
      logLevel: optional("LOG_LEVEL", "info"),
    };

    // 公開 repo 防灌池：正式寫表必須限定來源；memory 乾跑維持可用空名單。
    if (storage === "sheets" && cached.allowedChatIds.length === 0) {
      throw new Error(
        `STORAGE=sheets 但未設 ALLOWED_CHAT_IDS:正式寫表必須限定來源 chat id(逗號分隔純數字),否則公開後任何人都能灌你的${options.sheetsDestination}`,
      );
    }

    // 告警管道維持選配；sheets 模式未設時明講，但不阻止啟動。
    if (storage === "sheets" && cached.errorChatId === "") {
      logger.warn(
        "ERROR_CHAT_ID 未設,寫入失敗將無 Telegram 告警(只剩 collect.yml 紅燈/exit code)",
      );
    }

    return cached;
  };
}
