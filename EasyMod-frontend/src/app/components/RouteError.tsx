import { isRouteErrorResponse, useRouteError } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { buildAppUrl } from "@/app/lib/config";

export default function RouteError() {
  const error = useRouteError();
  const { t } = useTranslation();

  let title = t("shell.error.title");
  let message = t("shell.error.message");

  if (isRouteErrorResponse(error)) {
    title = `Error ${error.status}`;
    message = error.statusText || message;
  } else if (error instanceof Error) {
    message = error.message;
  }

  return (
    <div className="min-h-screen bg-em-bg-app flex items-center justify-center p-4">
      <div className="max-w-md w-full bg-em-bg-surface rounded-lg shadow-lg p-6 text-center">
        <h1 className="text-xl font-semibold text-em-text-primary mb-2">{title}</h1>
        <p className="text-em-text-secondary mb-6">{message}</p>
        <button
          onClick={() => window.location.assign(buildAppUrl("/dashboard"))}
          className="w-full min-h-11 bg-em-violet-600 text-white py-2 px-4 rounded-lg hover:bg-em-violet-700 transition-colors focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-em-focus-light focus-visible:transition-none"
        >
          {t("shell.error.back")}
        </button>
      </div>
    </div>
  );
}
