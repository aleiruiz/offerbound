import CloseOutlined from "@mui/icons-material/CloseOutlined";
import Box from "@mui/material/Box";
import Drawer from "@mui/material/Drawer";
import IconButton from "@mui/material/IconButton";
import Link from "@mui/material/Link";
import Skeleton from "@mui/material/Skeleton";
import Typography from "@mui/material/Typography";
import { useTheme } from "@mui/material/styles";
import useMediaQuery from "@mui/material/useMediaQuery";
import type { MessageDetail } from "@offerbound/contracts";
import { useMessage } from "../api/hooks";
import { DEFAULT_TIMEZONE, formatDateTime } from "../lib/format";
import { splitLinks } from "../lib/url";
import { ErrorState } from "./States";
import { t } from "../i18n";

/** The body as plain text; only `http(s)` URLs become links (SECURITY §10). */
function BodyText({ text }: { text: string }) {
  return (
    <Typography component="div" sx={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
      {splitLinks(text).map((part, i) =>
        part.type === "link" ? (
          <Link key={i} href={part.href} target="_blank" rel="noopener noreferrer">
            {part.text}
          </Link>
        ) : (
          part.text
        ),
      )}
    </Typography>
  );
}

function sender(message: MessageDetail): string {
  const name = message.fromName?.trim();
  const email = message.fromEmail;
  if (name && email) return `${name} (${email})`;
  return name || email || t("Unknown sender");
}

export interface EmailSheetProps {
  /** The email to show; `null` keeps the sheet closed. */
  messageId: string | null;
  onClose: () => void;
  timezone?: string;
}

/** A side sheet (bottom sheet on phones) that shows one email as text. */
export function EmailSheet({ messageId, onClose, timezone = DEFAULT_TIMEZONE }: EmailSheetProps) {
  const theme = useTheme();
  const phone = useMediaQuery(theme.breakpoints.down("sm"));
  const query = useMessage(messageId);
  const message = query.data;

  return (
    <Drawer
      anchor={phone ? "bottom" : "right"}
      open={messageId !== null}
      onClose={onClose}
      slotProps={{
        paper: {
          role: "dialog",
          "aria-modal": true,
          "aria-labelledby": "email-sheet-title",
          sx: {
            width: phone ? "auto" : "min(560px, 100vw)",
            maxHeight: phone ? "90vh" : "none",
            borderTopLeftRadius: phone ? 12 : 0,
            borderTopRightRadius: phone ? 12 : 0,
          },
        },
      }}
    >
      <Box sx={{ p: 2.5, display: "flex", flexDirection: "column", gap: 2 }}>
        <Box
          sx={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 1,
          }}
        >
          <Typography id="email-sheet-title" variant="h6" component="h2">
            {message ? (message.subject ?? t("No subject")) : t("Email")}
          </Typography>
          <IconButton aria-label={t("Close")} onClick={onClose} edge="end">
            <CloseOutlined fontSize="small" />
          </IconButton>
        </Box>

        {query.isError ? (
          <ErrorState
            what={t("the email")}
            error={query.error}
            onRetry={() => void query.refetch()}
          />
        ) : message ? (
          <>
            <Box>
              <Typography variant="body2" sx={{ fontWeight: 600 }}>
                {sender(message)}
              </Typography>
              <Typography variant="caption" color="text.secondary" component="p">
                {formatDateTime(message.internalDate, timezone)}
              </Typography>
            </Box>
            {message.bodyText ? (
              <BodyText text={message.bodyText} />
            ) : (
              <Typography color="text.secondary">{t("This email has no text to show.")}</Typography>
            )}
          </>
        ) : (
          <Box
            aria-busy="true"
            aria-label={t("Loading email")}
            sx={{ display: "flex", flexDirection: "column", gap: 1 }}
          >
            <Skeleton variant="rounded" width="40%" height={16} />
            <Skeleton variant="rounded" width="100%" height={14} />
            <Skeleton variant="rounded" width="90%" height={14} />
            <Skeleton variant="rounded" width="70%" height={14} />
          </Box>
        )}
      </Box>
    </Drawer>
  );
}
