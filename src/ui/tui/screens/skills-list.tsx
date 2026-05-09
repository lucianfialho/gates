import React, { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import { DEFAULT_PORT } from "../../server/index.js";

export interface SkillInfo {
  name: string;
  description: string;
  initialState: string;
  states: string[];
}

interface Props {
  onSelect: (skill: SkillInfo) => void;
  onBack: () => void;
}

export function SkillsList({ onSelect, onBack }: Props) {
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [selected, setSelected] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`http://localhost:${DEFAULT_PORT}/api/skills`)
      .then((r) => r.json())
      .then((data: unknown) => {
        setSkills(data as SkillInfo[]);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  useInput((input, key) => {
    if (key.upArrow) setSelected((s) => Math.max(0, s - 1));
    if (key.downArrow) setSelected((s) => Math.min(skills.length - 1, s + 1));
    if (key.return && skills[selected]) onSelect(skills[selected]!);
    if (key.escape || input === "q") onBack();
  });

  if (loading) {
    return (
      <Box padding={2}>
        <Text dimColor>Loading skills…</Text>
      </Box>
    );
  }

  if (skills.length === 0) {
    return (
      <Box padding={2} flexDirection="column">
        <Text>No skills found in .gates/skills/</Text>
        <Text dimColor>Create a skill.yaml to get started.</Text>
        <Box marginTop={1}><Text dimColor>Esc to go back</Text></Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" padding={2}>
      <Box marginBottom={1}>
        <Text bold color="magenta">◆ Skills</Text>
        <Text dimColor>  Select a skill to run</Text>
      </Box>
      <Box flexDirection="column">
        {skills.map((skill, i) => (
          <Box key={skill.name} flexDirection="column" marginBottom={1}>
            <Box>
              <Text color={i === selected ? "cyan" : undefined}>{i === selected ? "▶ " : "  "}</Text>
              <Text bold={i === selected}>{skill.name}</Text>
              <Text dimColor>  {skill.states.length} states</Text>
            </Box>
            {skill.description && (
              <Box paddingLeft={4}>
                <Text dimColor>{skill.description}</Text>
              </Box>
            )}
          </Box>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>↑↓ navigate  ↵ run  Esc back</Text>
      </Box>
    </Box>
  );
}
