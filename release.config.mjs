import process from "node:process";

const stableBranch = process.env.DEFAULT_BRANCH || "master";

export default {
  branches: [stableBranch, { name: "beta", prerelease: true }],
  plugins: [
    "@semantic-release/commit-analyzer",
    "@semantic-release/release-notes-generator",
    [
      "semantic-release-run-when",
      {
        when: { main: true },
        plugin: [
          "@semantic-release/changelog",
          {
            changelogTitle: "# Changelog",
          },
        ],
      },
    ],
    "@semantic-release/npm",
    [
      "semantic-release-run-when",
      {
        when: { main: true },
        plugin: "@semantic-release/git",
      },
    ],
    "@semantic-release/github",
  ],
  tagFormat: "${version}",
};
