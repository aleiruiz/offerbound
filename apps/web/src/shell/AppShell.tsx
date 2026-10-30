import AppBar from "@mui/material/AppBar";
import Box from "@mui/material/Box";
import BottomNavigation from "@mui/material/BottomNavigation";
import BottomNavigationAction from "@mui/material/BottomNavigationAction";
import Drawer from "@mui/material/Drawer";
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
import MoreHorizOutlined from "@mui/icons-material/MoreHorizOutlined";
import { useRef, useState } from "react";
import { Link, Outlet, useLocation } from "react-router";
import {
  BOTTOM_NAV_KEYS,
  MORE_NAV_KEYS,
  NAV_ITEMS,
  activeNavItem,
  navItemsFor,
  type NavItem,
} from "./nav";

const DRAWER_WIDTH = 240;
const RAIL_WIDTH = 72;

function useShellVariant(): "drawer" | "rail" | "bottom" {
  const theme = useTheme();
  const md = useMediaQuery(theme.breakpoints.up("md"), { noSsr: true });
  const sm = useMediaQuery(theme.breakpoints.up("sm"), { noSsr: true });
  return md ? "drawer" : sm ? "rail" : "bottom";
}

function Wordmark() {
  return (
    <Typography
      component="span"
      sx={{ fontSize: 22, lineHeight: "28px", fontWeight: 800, letterSpacing: "-0.01em" }}
    >
      Offerbound
    </Typography>
  );
}

function DrawerNav({ active }: { active: NavItem | undefined }) {
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
        aria-label="Main"
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
                  primary={item.label}
                  slotProps={{ primary: { sx: { fontWeight: selected ? 700 : 600 } } }}
                />
              </ListItemButton>
            );
          })}
        </List>
      </Box>
    </Drawer>
  );
}

function RailNav({ active }: { active: NavItem | undefined }) {
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
      <Box component="nav" aria-label="Main" sx={{ px: 1, py: 3 }}>
        <List disablePadding sx={{ display: "flex", flexDirection: "column", gap: 0.5 }}>
          {NAV_ITEMS.map((item) => {
            const selected = item.key === active?.key;
            const Icon = item.icon;
            return (
              <Tooltip key={item.key} title={item.label} placement="right">
                <ListItemButton
                  component={Link}
                  to={item.to}
                  selected={selected}
                  aria-label={item.label}
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
                    <Icon sx={{ fontSize: 20 }} />
                  </ListItemIcon>
                </ListItemButton>
              </Tooltip>
            );
          })}
        </List>
      </Box>
    </Drawer>
  );
}

function BottomNav({ active }: { active: NavItem | undefined }) {
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
      aria-label="Main"
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
          return (
            <BottomNavigationAction
              key={item.key}
              component={Link}
              to={item.to}
              value={item.key}
              label={item.label}
              aria-current={item.key === active?.key ? "page" : undefined}
              icon={<Icon sx={{ fontSize: 20 }} />}
              sx={{ minWidth: 0, minHeight: 44 }}
            />
          );
        })}
        <BottomNavigationAction
          ref={moreRef}
          value="more"
          label="More"
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
              {item.label}
            </MenuItem>
          );
        })}
      </Menu>
    </Paper>
  );
}

/**
 * The signed-in shell (DESIGN_SPEC §4): permanent drawer from `md`, a 72px rail at `sm`,
 * and a top bar with bottom navigation below 600px. Pages render in the outlet.
 */
export function AppShell() {
  const variant = useShellVariant();
  const { pathname } = useLocation();
  const active = activeNavItem(pathname);

  return (
    <Box sx={{ display: "flex", minHeight: "100vh", bgcolor: "background.default" }}>
      {variant === "drawer" && <DrawerNav active={active} />}
      {variant === "rail" && <RailNav active={active} />}
      <Box sx={{ flexGrow: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        {variant === "bottom" && (
          <AppBar
            position="sticky"
            color="inherit"
            sx={{ bgcolor: "background.paper", border: 0, borderBottom: 1, borderColor: "divider" }}
          >
            <Toolbar sx={{ minHeight: 56 }}>
              <Typography component="span" variant="h6" sx={{ flexGrow: 1 }}>
                {active?.label ?? "Offerbound"}
              </Typography>
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
          <Outlet />
        </Box>
      </Box>
      {variant === "bottom" && <BottomNav active={active} />}
    </Box>
  );
}
