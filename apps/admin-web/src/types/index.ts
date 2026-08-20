import type { UserRecord } from "@sentinel/shared";

export type AdminSession = {
  token: string;
  expiresAt: string;
  user: UserRecord;
};
