import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import Typography from "@mui/material/Typography";
import type { CvProfile } from "@offerbound/contracts";

/**
 * The read-only summary of the CV profile (AC-11.3): headline, a line of facts, core skills and
 * recent roles. The profile is personal content: it is only ever rendered, never logged.
 */
export function CvProfileSummary({ profile }: { profile: CvProfile }) {
  const facts = [
    profile.yearsExperience !== null
      ? `${profile.yearsExperience} ${profile.yearsExperience === 1 ? "year" : "years"} of experience`
      : null,
    profile.location,
    profile.languages.length > 0 ? profile.languages.join(", ") : null,
    profile.workAuthorization,
  ].filter((fact): fact is string => fact !== null && fact !== "");

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 1.5 }}>
      <Box>
        <Typography sx={{ fontWeight: 600 }}>{profile.headline}</Typography>
        {facts.length > 0 ? (
          <Typography variant="caption" color="text.secondary" component="p">
            {facts.join(" · ")}
          </Typography>
        ) : null}
      </Box>
      {profile.coreSkills.length > 0 ? (
        <Box component="ul" aria-label="Core skills" sx={chipList}>
          {profile.coreSkills.map((skill) => (
            <li key={skill}>
              <Chip size="small" label={skill} />
            </li>
          ))}
        </Box>
      ) : null}
      {profile.recentRoles.length > 0 ? (
        <Box component="ul" aria-label="Recent roles" sx={{ listStyle: "none", m: 0, p: 0 }}>
          {profile.recentRoles.map((role, index) => (
            <Typography
              key={`${role.title}-${role.company}-${index}`}
              component="li"
              variant="body2"
            >
              <Box component="span" sx={{ fontWeight: 600 }}>
                {role.title}
              </Box>
              {`, ${role.company}`}
              {role.years ? (
                <Typography component="span" variant="caption" color="text.secondary">
                  {` · ${role.years}`}
                </Typography>
              ) : null}
            </Typography>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}

const chipList = {
  display: "flex",
  flexWrap: "wrap",
  gap: 0.75,
  listStyle: "none",
  m: 0,
  p: 0,
} as const;
