import type { NavCounts } from "@offerbound/contracts";
import AppBar from "@mui/material/AppBar";
import Badge from "@mui/material/Badge";
import Box from "@mui/material/Box";
import BottomNavigation from "@mui/material/BottomNavigation";
import BottomNavigationAction from "@mui/material/BottomNavigationAction";
import Drawer from "@mui/material/Drawer";
import IconButton from "@mui/material/IconButton";
import List from "@mui/material/List";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import Paper from "@mui/material/Paper";
import Toolbar from "@mui/material/Toolbar";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { useTheme } from "@mui/material/styles";
import useMediaQuery from "@mui/material/useMediaQuery";
import ArrowBackOutlined from "@mui/icons-material/ArrowBackOutlined";
import KeyboardOutlined from "@mui/icons-material/KeyboardOutlined";
import MoreHorizOutlined from "@mui/icons-material/MoreHorizOutlined";
import { useRef, useState, type ReactNode } from "react";
import { Link, Outlet, useLocation } from "react-router";
import { useNavCounts } from "../api/hooks";
import { Logo } from "../components/Logo";
import { ShortcutDialog } from "../components/ShortcutDialog";
import { UndoSnackbar } from "../components/UndoSnackbar";
import { setShortcutDialogOpen, useGlobalShortcuts } from "../lib/shortcuts";
import {
  BOTTOM_NAV_KEYS,
  MORE_NAV_KEYS,
  NAV_ITEMS,
  activeNavItem,
  navItemsFor,
  type NavItem,
  type NavKey,
} from "./nav";
import { DemoBanner } from "./DemoBanner";
import { parentOf, useTrackOrigin } from "./origin";
import { ReconnectBanner } from "./ReconnectBanner";
import { SyncStatus } from "./SyncStatus";
import { t } from "../i18n";

const DRAWER_WIDTH = 240;
const RAIL_WIDTH = 72;

function useShellVariant(): "drawer" | "rail" | "bottom" {
  const theme = useTheme();
  const md = useMediaQuery(theme.breakpoints.up("md"), { noSsr: true });
  const sm = useMediaQuery(theme.breakpoints.up("sm"), { noSsr: true });
  return md ? "drawer" : sm ? "rail" : "bottom";
}

const COUNT_KEY: Partial<Record<NavKey, keyof NavCounts>> = {
  applications: "openApplications",
  leads: "newLeads",
  interviews: "upcomingInterviews",
  review: "openReview",
};

/** The number behind a destination's badge, or 0 while the counts load or when there is none. */
function countFor(key: NavKey, counts: NavCounts | undefined): number {
  const field = COUNT_KEY[key];
  return field && counts ? counts[field] : 0;
}

/** Drawer badge (DESIGN_SPEC §3): plain small text, except Review's amber pill. */
function NavCount({ navKey, count }: { navKey: NavKey; count: number }) {
  if (count <= 0) return null;
  if (navKey === "review") {
    return (
      <Box
        component="span"
        sx={{
          minWidth: 22,
          height: 22,
          px: "6px",
          boxSizing: "border-box",
          borderRadius: "11px",
          bgcolor: "warning.main",
          color: "warning.contrastText",
          fontSize: 12,
          lineHeight: "22px",
          fontWeight: 700,
          textAlign: "center",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {count}
      </Box>
    );
  }
  return (
    <Typography
      component="span"
      variant="caption"
      sx={{ color: "text.secondary", fontVariantNumeric: "tabular-nums" }}
    >
      {navKey === "leads" ? t("{count} new", { count }) : count}
    </Typography>
  );
}

/** The rail and the bottom navigation badge only Review (DESIGN_SPEC §4). */
function reviewLabel(label: string, key: NavKey, count: number): string {
  return key === "review" && count > 0
    ? t("{label}, {count} open", { label: t(label), count })
    : t(label);
}

function IconWithBadge({
  navKey,
  count,
  children,
}: {
  navKey: NavKey;
  count: number;
  children: ReactNode;
}) {
  if (navKey !== "review" || count <= 0) return <>{children}</>;
  return (
    <Badge badgeContent={count} max={99} color="warning">
      {children}
    </Badge>
  );
}

/** The lockup is drawn on a 64px-high canvas with padding; the negative margin keeps the 28px line. */
function Wordmark() {
  return <Logo height={40} style={{ margin: "-6px 0" }} />;
}

function DrawerNav({
  active,
  counts,
}: {
  active: NavItem | undefined;
  counts: NavCounts | undefined;
}) {
  return (
    <Drawer
      variant="permanent"
      sx={{
        width: DRAWER_WIDTH,
        flexShrink: 0,
        "& .MuiDrawer-paper": {
          width: DRAWER_WIDTH,
          boxSizing: "border-box",
          border: 0,
          borderRight: 1,
          borderColor: "divider",
        },
      }}
    >
      <Box
        component="nav"
        aria-label={t("Main")}
        sx={{ display: "flex", flexDirection: "column", gap: 3.5, px: 1.5, py: 3, flexGrow: 1 }}
      >
        <Box sx={{ px: 1.5, display: "flex", flexDirection: "column", gap: "2px" }}>
          <Wordmark />
          <Typography variant="caption" color="text.secondary">
            {window.location.host}
          </Typography>
        </Box>
        <List disablePadding sx={{ display: "flex", flexDirection: "column", gap: 0.5 }}>
          {NAV_ITEMS.map((item) => {
            const selected = item.key === active?.key;
            const Icon = item.icon;
            return (
              <ListItemButton
                key={item.key}
                component={Link}
                to={item.to}
                selected={selected}
                aria-current={selected ? "page" : undefined}
                sx={{
                  height: 44,
                  borderRadius: 1,
                  gap: 1.5,
                  px: 1.5,
                  "&.Mui-selected, &.Mui-selected:hover": {
                    backgroundColor: "tokens.routeTint",
                    color: "primary.main",
                  },
                }}
              >
                <ListItemIcon sx={{ minWidth: 0, color: "inherit" }}>
                  <Icon sx={{ fontSize: 20 }} />
                </ListItemIcon>
                <ListItemText
                  primary={t(item.label)}
                  slotProps={{ primary: { sx: { fontWeight: selected ? 700 : 600 } } }}
                />
                <NavCount navKey={item.key} count={countFor(item.key, counts)} />
              </ListItemButton>
            );
          })}
        </List>
        <Box
          sx={{
            mt: "auto",
            display: "flex",
            flexDirection: "column",
            borderTop: 1,
            borderColor: "divider",
            pt: 1,
          }}
        >
          <SyncStatus layout="footer" />
          <ListItemButton
            onClick={() => setShortcutDialogOpen(true)}
            sx={{ height: 44, borderRadius: 1, gap: 1.5, px: 1.5 }}
          >
            <ListItemIcon sx={{ minWidth: 0, color: "inherit" }}>
              <KeyboardOutlined sx={{ fontSize: 20 }} />
            </ListItemIcon>
            <ListItemText
              primary={t("Keyboard shortcuts")}
              slotProps={{ primary: { variant: "body2" } }}
            />
          </ListItemButton>
        </Box>
      </Box>
    </Drawer>
  );
}

function RailNav({
  active,
  counts,
}: {
  active: NavItem | undefined;
  counts: NavCounts | undefined;
}) {
  return (
    <Drawer
      variant="permanent"
      sx={{
        width: RAIL_WIDTH,
        flexShrink: 0,
        "& .MuiDrawer-paper": {
          width: RAIL_WIDTH,
          boxSizing: "border-box",
          border: 0,
          borderRight: 1,
          borderColor: "divider",
        },
      }}
    >
      <Box
        component="nav"
        aria-label={t("Main")}
        sx={{ display: "flex", flexDirection: "column", flexGrow: 1, px: 1, py: 3 }}
      >
        <Box sx={{ display: "flex", justifyContent: "center", pb: 2 }}>
          <Logo variant="mark" height={32} />
        </Box>
        <List disablePadding sx={{ display: "flex", flexDirection: "column", gap: 0.5 }}>
          {NAV_ITEMS.map((item) => {
            const selected = item.key === active?.key;
            const Icon = item.icon;
            const count = countFor(item.key, counts);
            return (
              <Tooltip key={item.key} title={t(item.label)} placement="right">
                <ListItemButton
                  component={Link}
                  to={item.to}
                  selected={selected}
                  aria-label={reviewLabel(item.label, item.key, count)}
                  aria-current={selected ? "page" : undefined}
                  sx={{
                    height: 44,
                    borderRadius: 1,
                    justifyContent: "center",
                    px: 0,
                    "&.Mui-selected, &.Mui-selected:hover": {
                      backgroundColor: "tokens.routeTint",
                      color: "primary.main",
                    },
                  }}
                >
                  <ListItemIcon sx={{ minWidth: 0, color: "inherit" }}>
                    <IconWithBadge navKey={item.key} count={count}>
                      <Icon sx={{ fontSize: 20 }} />
                    </IconWithBadge>
                  </ListItemIcon>
                </ListItemButton>
              </Tooltip>
            );
          })}
        </List>
        <Box
          sx={{
            mt: "auto",
            display: "flex",
            flexDirection: "column",
            gap: 0.5,
            borderTop: 1,
            borderColor: "divider",
            pt: 1,
          }}
        >
          <SyncStatus layout="rail" />
          <Tooltip title={t("Keyboard shortcuts")} placement="right">
            <ListItemButton
              aria-label={t("Keyboard shortcuts")}
              onClick={() => setShortcutDialogOpen(true)}
              sx={{ height: 44, borderRadius: 1, justifyContent: "center", px: 0 }}
            >
              <ListItemIcon sx={{ minWidth: 0, color: "inherit" }}>
                <KeyboardOutlined sx={{ fontSize: 20 }} />
              </ListItemIcon>
            </ListItemButton>
          </Tooltip>
        </Box>
      </Box>
    </Drawer>
  );
}

function BottomNav({
  active,
  counts,
}: {
  active: NavItem | undefined;
  counts: NavCounts | undefined;
}) {
  const moreRef = useRef<HTMLButtonElement>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreActive = active !== undefined && MORE_NAV_KEYS.includes(active.key);
  const value = moreActive
    ? "more"
    : active && BOTTOM_NAV_KEYS.includes(active.key)
      ? active.key
      : false;

  return (
    <Paper
      component="nav"
      aria-label={t("Main")}
      sx={{
        position: "fixed",
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: (theme) => theme.zIndex.appBar,
        border: 0,
        borderTop: 1,
        borderColor: "divider",
        borderRadius: 0,
        paddingBottom: "env(safe-area-inset-bottom)",
      }}
    >
      <BottomNavigation showLabels value={value} sx={{ height: 64 }}>
        {navItemsFor(BOTTOM_NAV_KEYS).map((item) => {
          const Icon = item.icon;
          const count = countFor(item.key, counts);
          return (
            <BottomNavigationAction
              key={item.key}
              component={Link}
              to={item.to}
              value={item.key}
              label={t(item.label)}
              aria-label={reviewLabel(item.label, item.key, count)}
              aria-current={item.key === active?.key ? "page" : undefined}
              icon={
                <IconWithBadge navKey={item.key} count={count}>
                  <Icon sx={{ fontSize: 20 }} />
                </IconWithBadge>
              }
              sx={{ minWidth: 0, minHeight: 44 }}
            />
          );
        })}
        <BottomNavigationAction
          ref={moreRef}
          value="more"
          label={t("More")}
          icon={<MoreHorizOutlined sx={{ fontSize: 20 }} />}
          aria-haspopup="menu"
          aria-expanded={moreOpen}
          onClick={() => setMoreOpen(true)}
          sx={{ minWidth: 0, minHeight: 44 }}
        />
      </BottomNavigation>
      <Menu
        open={moreOpen}
        anchorEl={moreRef.current}
        onClose={() => setMoreOpen(false)}
        anchorOrigin={{ vertical: "top", horizontal: "right" }}
        transformOrigin={{ vertical: "bottom", horizontal: "right" }}
      >
        {navItemsFor(MORE_NAV_KEYS).map((item) => {
          const Icon = item.icon;
          return (
            <MenuItem
              key={item.key}
              component={Link}
              to={item.to}
              selected={item.key === active?.key}
              onClick={() => setMoreOpen(false)}
              sx={{ minHeight: 44, gap: 1.5 }}
            >
              <Icon sx={{ fontSize: 20 }} />
              {t(item.label)}
            </MenuItem>
          );
        })}
        <MenuItem
          onClick={() => {
            setMoreOpen(false);
            setShortcutDialogOpen(true);
          }}
          sx={{ minHeight: 44, gap: 1.5 }}
        >
          <KeyboardOutlined sx={{ fontSize: 20 }} />
          {t("Keyboard shortcuts")}
        </MenuItem>
      </Menu>
    </Paper>
  );
}

/**
 * The signed-in shell (DESIGN_SPEC §4): permanent drawer from `md`, a 72px rail at `sm`,
 * and a top bar with bottom navigation below 600px. Pages render in the outlet.
 */
export function AppShell() {
  useGlobalShortcuts();
  useTrackOrigin();
  const variant = useShellVariant();
  const { pathname } = useLocation();
  const active = activeNavItem(pathname);
  const counts = useNavCounts().data;
  // On phones a record or a settings section has no navigation of its own: the top bar leads back.
  const parent = variant === "bottom" ? parentOf(pathname) : undefined;

  return (
    <Box sx={{ display: "flex", minHeight: "100vh", bgcolor: "background.default" }}>
      {variant === "drawer" && <DrawerNav active={active} counts={counts} />}
      {variant === "rail" && <RailNav active={active} counts={counts} />}
      <Box sx={{ flexGrow: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        <DemoBanner />
        {variant === "bottom" && (
          <AppBar
            position="sticky"
            color="inherit"
            sx={{ bgcolor: "background.paper", border: 0, borderBottom: 1, borderColor: "divider" }}
          >
            <Toolbar sx={{ minHeight: 56 }}>
              {parent ? (
                <Tooltip title={t("Back to {page}", { page: t(parent.label) })}>
                  <IconButton
                    component={Link}
                    to={parent.to}
                    edge="start"
                    aria-label={t("Back to {page}", { page: t(parent.label) })}
                    sx={{ mr: 1, width: 44, height: 44 }}
                  >
                    <ArrowBackOutlined sx={{ fontSize: 20 }} />
                  </IconButton>
                </Tooltip>
              ) : (
                <Logo variant="mark" height={28} style={{ marginRight: 12 }} />
              )}
              <Typography component="span" variant="h6" sx={{ flexGrow: 1, minWidth: 0 }} noWrap>
                {active ? t(active.label) : "Offerbound"}
              </Typography>
              <SyncStatus layout="bar" />
            </Toolbar>
          </AppBar>
        )}
        <Box
          component="main"
          sx={{
            width: "100%",
            maxWidth: 1200,
            mx: "auto",
            p: { xs: 2, sm: 3, md: 4 },
            pb: { xs: "calc(64px + env(safe-area-inset-bottom) + 16px)", sm: 3, md: 4 },
          }}
        >
          <ReconnectBanner />
          <Outlet />
        </Box>
      </Box>
      {variant === "bottom" && <BottomNav active={active} counts={counts} />}
      <ShortcutDialog />
      <UndoSnackbar />
    </Box>
  );
}
