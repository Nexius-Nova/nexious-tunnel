const common = new Set(["12345678", "password", "qwertyui", "admin123", "password1234", "password12345", "123456789012", "qwerty123456", "admin1234567", "administrator", "changeme12345"]);
export function passwordIssue(value: string): string | null {
  if (value.length < 8) return "密码至少 8 位，建议使用易记的长密码或密码短语";
  if (value.length > 128) return "密码最多 128 位";
  if (!value.trim() || /^(.)\1+$/.test(value) || common.has(value.toLowerCase())) return "请避免常见、重复或纯空格密码";
  return null;
}
export function usernameIssue(value: string): string | null {
  return /^[a-zA-Z0-9._-]{3,32}$/.test(value.trim()) ? null : "用户名需为 3-32 位字母、数字或 . _ -";
}
export function generatePassword() {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  return Array.from(crypto.getRandomValues(new Uint8Array(24)), byte => alphabet[byte & 63]).join("");
}
