# Create a GitHub issue

Read repository-policy, issue-authoring and publication. Trigger only for a request to record/publish a GitHub work item; an instruction to fix code is not an instruction to file an issue.

Inspect the repository and demand, determine requested language, choose the actual applicable template/type and prepare a proportionate issue. Obtain actual labels and avoid creating taxonomy unless explicitly authorized. Use the canonical defaults helper only where no convention is declared; do not impose historical Bug/Enhancement/Architecture prefixes.

Search open and closed issues with several targeted keywords and applicable labels before publishing. For a matching open issue return its URL and proposed additions; comment only when authorized. Ask about uncertain duplication or scope splits.

Publish using an authenticated GitHub capability. With gh use issue create --title <title> --body-file <file>, adding non-empty validated labels and a supported native --type when appropriate. Check installed gh help before relying on a version-dependent flag; use the GitHub API if the capability exists there. Keep user content out of shell interpolation.

If GitHub access is unavailable, prepare and return the draft with the concrete blocker; do not silently change the destination to local. Preserve drafts on failures and re-query before retrying uncertain creates. Cross-reference related issues only when that commenting action is authorized. Return confirmed URL, or draft location plus the unresolved action.
