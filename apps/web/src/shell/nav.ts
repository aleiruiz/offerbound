import type { SvgIconComponent } from "@mui/icons-material";
import EventOutlined from "@mui/icons-material/EventOutlined";
import RuleOutlined from "@mui/icons-material/RuleOutlined";
import SettingsOutlined from "@mui/icons-material/SettingsOutlined";
import TodayOutlined from "@mui/icons-material/TodayOutlined";
import TravelExploreOutlined from "@mui/icons-material/TravelExploreOutlined";
// MUI icons v9 dropped the legacy WorkOutline name; WorkOutlineOutlined is the same Outlined glyph.
import WorkOutlineOutlined from "@mui/icons-material/WorkOutlineOutlined";

export type NavKey = "today" | "applications" | "leads" | "interviews" | "review" | "settings";

export interface NavItem {
  key: NavKey;
  label: string;
  /** Where the link goes. */
  to: string;
  /** The path prefix that makes this destination the current one. */
  prefix: string;
  icon: SvgIconComponent;
}

// DESIGN_SPEC §3 (destinations) and §2.3 (icons).
export const NAV_ITEMS: readonly NavItem[] = [
  { key: "today", label: "Today", to: "/today", prefix: "/today", icon: TodayOutlined },
  {
    key: "applications",
    label: "Applications",
    to: "/applications",
    prefix: "/applications",
    icon: WorkOutlineOutlined,
  },
  { key: "leads", label: "Leads", to: "/leads", prefix: "/leads", icon: TravelExploreOutlined },
  {
    key: "interviews",
    label: "Interviews",
    to: "/interviews",
    prefix: "/interviews",
    icon: EventOutlined,
  },
  { key: "review", label: "Review", to: "/review", prefix: "/review", icon: RuleOutlined },
  {
    key: "settings",
    label: "Settings",
    to: "/settings",
    prefix: "/settings",
    icon: SettingsOutlined,
  },
];

/** Bottom navigation below 600px (DESIGN_SPEC §4): four destinations, then More. */
export const BOTTOM_NAV_KEYS: readonly NavKey[] = ["today", "applications", "leads", "review"];
export const MORE_NAV_KEYS: readonly NavKey[] = ["interviews", "settings"];

export function navItemsFor(keys: readonly NavKey[]): NavItem[] {
  return NAV_ITEMS.filter((item) => keys.includes(item.key));
}

export function activeNavItem(pathname: string): NavItem | undefined {
  return NAV_ITEMS.find(
    (item) => pathname === item.prefix || pathname.startsWith(`${item.prefix}/`),
  );
}
