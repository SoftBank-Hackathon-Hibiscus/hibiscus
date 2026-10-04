import type { ConnectionState } from "../hooks/useConnection";
import { oauthStartUrl, backendBaseUrl } from "../lib/backendUrl";
import { useLang } from "../lib/i18n";
import { APPLICATIONS_PATH, REGISTER_PATH, realHref } from "../lib/router";
import { ErrorNotice } from "../components/ErrorNotice";
export function Connect({
  connection,
  onRecheck,
}: {
  connection: ConnectionState;
  onRecheck: () => void;
}) {
  const { lang, t } = useLang();
  const signedIn = connection.level === "ok";
  return (
    <div className="page">
      <section className="card login-simple">
        <h1>
          {signedIn
            ? "Hibiscus"
            : lang === "ko"
              ? "Hibiscus 로그인"
              : "Hibiscusログイン"}
        </h1>
        {signedIn ? (
          <div className="stack">
            <p className="small muted">@{connection.user.login}</p>
            <a className="btn btn-primary" href={realHref(APPLICATIONS_PATH)}>
              {t("homeCtaApps")}
            </a>
            <a className="btn" href={realHref(REGISTER_PATH)}>
              {t("registerApp")}
            </a>
          </div>
        ) : (
          <div className="stack">
            <p className="small muted">
              {lang === "ko"
                ? "GitHub 계정으로 시작하세요."
                : "GitHubアカウントで始めましょう。"}
            </p>
            {connection.level === "checking" ? (
              <p>{t("connChecking")}</p>
            ) : connection.level === "down" ? (
              <>
                <ErrorNotice
                  error={new Error(connection.detail ?? "Server unavailable")}
                />
                <button className="btn" onClick={onRecheck}>
                  {t("recheck")}
                </button>
              </>
            ) : (
              <>
                <a
                  className="btn btn-primary"
                  href={oauthStartUrl(backendBaseUrl())}
                >
                  {lang === "ko" ? "GitHub로 로그인" : "GitHubでログイン"}
                </a>
                {connection.tokenPresent && (
                  <p className="small tone-warning">{t("savedTokenInvalid")}</p>
                )}
              </>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
