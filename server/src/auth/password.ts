import bcrypt from "bcryptjs";

/** bcrypt のコスト。テスト時のみ BCRYPT_COST で下げられる(本番は常に 12) */
export function targetCost(): number {
  if (process.env.NODE_ENV === "test") {
    const c = Number(process.env.BCRYPT_COST);
    if (Number.isInteger(c) && c >= 4 && c <= 31) return c;
  }
  return 12;
}

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, targetCost());
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

/** 保存済みハッシュのコストが現在の目標より低ければ true(ログイン成功時に再ハッシュする)。 */
export function needsRehash(hash: string): boolean {
  const m = /^\$2[abxy]\$(\d{2})\$/.exec(hash);
  return !m || Number(m[1]) < targetCost();
}
