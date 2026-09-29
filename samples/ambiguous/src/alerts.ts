import { sendSms } from "./sms-client";

interface UserRow {
  name: string;
  emergency_no: string | null;
}

export async function notifyOverdue(user: UserRow, overdue: number): Promise<void> {
  if (overdue === 0) return;
  if (!user.emergency_no) return;
  await sendSms(user.emergency_no, `${user.name}님, 기한이 지난 할 일이 ${overdue}개 있습니다.`);
}
