// 외부 SMS 게이트웨이 어댑터 (데모용 스텁)
export async function sendSms(to: string, body: string): Promise<void> {
  const SMS_API_KEY = process.env.SMS_API_KEY ?? "";
  await fetch("https://sms.example.com/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${SMS_API_KEY}` },
    body: JSON.stringify({ to, body }),
  });
}
