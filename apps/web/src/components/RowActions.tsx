import MoreHorizOutlined from "@mui/icons-material/MoreHorizOutlined";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import Tooltip from "@mui/material/Tooltip";
import { useTheme } from "@mui/material/styles";
import useMediaQuery from "@mui/material/useMediaQuery";
import { useId, useState, type ReactNode } from "react";
import { Link as RouterLink } from "react-router";
import { t } from "../i18n";

export interface RowAction {
  key: string;
  label: string;
  /** How it looks as a button from 600px: outlined, text, or an icon-only button with a tooltip. */
  kind: "outlined" | "text" | "icon";
  icon?: ReactNode;
  /** Exactly one of these: a handler, an in-app route, or an external URL (opens in a new tab). */
  onClick?: () => void;
  to?: string;
  href?: string;
  /** Turns the action off and says why in a tooltip (the demo's read-only controls). */
  disabledReason?: string;
}

/**
 * The actions at the end of a row. From 600px they are buttons; below 600px they move into a `⋯`
 * menu with 44px items (DESIGN_SPEC §9.4).
 */
export function RowActions({ actions, label }: { actions: RowAction[]; label?: string }) {
  const theme = useTheme();
  const phone = useMediaQuery(theme.breakpoints.down("sm"), { noSsr: true });
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const menuId = useId();
  if (actions.length === 0) return null;

  if (phone) {
    return (
      <>
        <IconButton
          aria-label={label ?? t("More actions")}
          aria-haspopup="menu"
          aria-controls={anchor ? menuId : undefined}
          aria-expanded={anchor ? true : undefined}
          onClick={(e) => setAnchor(e.currentTarget)}
        >
          <MoreHorizOutlined />
        </IconButton>
        <Menu id={menuId} anchorEl={anchor} open={anchor !== null} onClose={() => setAnchor(null)}>
          {actions.map((a) => {
            const link = a.to
              ? { component: RouterLink, to: a.to }
              : a.href
                ? { component: "a", href: a.href, target: "_blank", rel: "noopener noreferrer" }
                : {};
            const item = (
              <MenuItem
                key={a.key}
                {...link}
                disabled={a.disabledReason !== undefined}
                sx={{ minHeight: 44 }}
                onClick={() => {
                  setAnchor(null);
                  a.onClick?.();
                }}
              >
                {a.icon ? <ListItemIcon>{a.icon}</ListItemIcon> : null}
                {a.label}
              </MenuItem>
            );
            return a.disabledReason === undefined ? (
              item
            ) : (
              <Tooltip key={a.key} title={a.disabledReason}>
                <Box component="span" sx={{ display: "block" }}>
                  {item}
                </Box>
              </Tooltip>
            );
          })}
        </Menu>
      </>
    );
  }

  return (
    <Box sx={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 0.5 }}>
      {actions.map((a) => {
        const link = a.to
          ? { component: RouterLink, to: a.to }
          : a.href
            ? { component: "a", href: a.href, target: "_blank", rel: "noopener noreferrer" }
            : {};
        if (a.kind === "icon") {
          if (a.disabledReason !== undefined) {
            // A disabled button takes no pointer events, so the tooltip hangs on a wrapper.
            return (
              <Tooltip key={a.key} title={a.disabledReason}>
                <Box component="span" tabIndex={0} sx={{ display: "inline-flex" }}>
                  <IconButton aria-label={a.label} size="small" disabled>
                    {a.icon}
                  </IconButton>
                </Box>
              </Tooltip>
            );
          }
          return (
            <Tooltip key={a.key} title={a.label}>
              <IconButton aria-label={a.label} size="small" onClick={a.onClick} {...link}>
                {a.icon}
              </IconButton>
            </Tooltip>
          );
        }
        const button = (
          <Button
            key={a.key}
            size="small"
            variant={a.kind === "outlined" ? "outlined" : "text"}
            onClick={a.onClick}
            disabled={a.disabledReason !== undefined}
            {...link}
          >
            {a.label}
          </Button>
        );
        // A disabled button takes no pointer events, so the tooltip hangs on a wrapper.
        return a.disabledReason === undefined ? (
          button
        ) : (
          <Tooltip key={a.key} title={a.disabledReason}>
            <Box component="span" tabIndex={0} sx={{ display: "inline-flex" }}>
              {button}
            </Box>
          </Tooltip>
        );
      })}
    </Box>
  );
}
