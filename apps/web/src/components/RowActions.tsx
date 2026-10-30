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
}

/**
 * The actions at the end of a row. From 600px they are buttons; below 600px they move into a `⋯`
 * menu with 44px items (DESIGN_SPEC §9.4).
 */
export function RowActions({
  actions,
  label = "More actions",
}: {
  actions: RowAction[];
  label?: string;
}) {
  const theme = useTheme();
  const phone = useMediaQuery(theme.breakpoints.down("sm"), { noSsr: true });
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const menuId = useId();
  if (actions.length === 0) return null;

  if (phone) {
    return (
      <>
        <IconButton
          aria-label={label}
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
            return (
              <MenuItem
                key={a.key}
                {...link}
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
          return (
            <Tooltip key={a.key} title={a.label}>
              <IconButton aria-label={a.label} size="small" onClick={a.onClick} {...link}>
                {a.icon}
              </IconButton>
            </Tooltip>
          );
        }
        return (
          <Button
            key={a.key}
            size="small"
            variant={a.kind === "outlined" ? "outlined" : "text"}
            onClick={a.onClick}
            {...link}
          >
            {a.label}
          </Button>
        );
      })}
    </Box>
  );
}
