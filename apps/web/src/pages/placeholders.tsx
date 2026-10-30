import Typography from "@mui/material/Typography";

/**
 * Placeholder pages: each renders its title as the page's one h1 (DESIGN_SPEC §9.2).
 * The tasks of M8 replace them one by one with the real pages.
 */
function PlaceholderPage({ title }: { title: string }) {
  return (
    <Typography variant="h4" component="h1">
      {title}
    </Typography>
  );
}

export const SettingsPage = () => <PlaceholderPage title="Settings" />;
