"""SMS 발송 (데모용 가짜 클라이언트)."""
import os
import urllib.request

SMS_API_KEY = os.environ.get("SMS_API_KEY", "")


def send_sms(text, to):
    req = urllib.request.Request(
        "https://sms.example.com/send",
        data=("to=%s&text=%s" % (to, text)).encode("utf-8"),
        headers={"Authorization": "Bearer " + SMS_API_KEY},
    )
    urllib.request.urlopen(req)
