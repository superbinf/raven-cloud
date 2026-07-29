import { deriveCaptchaAnswer } from "@sentinel/auth-captcha";

export async function loginWithCaptcha(request, { account, password, secret }) {
  const challenge = await request("/api/auth/captcha");
  if (challenge.status !== 200 || !challenge.body?.captchaId) throw new Error("测试环境无法获取登录验证码");
  return request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({
      account,
      password,
      captchaId: challenge.body.captchaId,
      captchaCode: deriveCaptchaAnswer(secret, challenge.body.captchaId)
    })
  });
}
