Use the repository's applicable issue template instead of layering another body template over it. Fill required fields; ask when two templates fit equally. Keep the PR template's sections, explaining non-applicable ones briefly.

Use existing label casing. Never create a label unless explicitly opted in by issues.allowLabelCreation and the action is authorized. Drop labels known to be absent; report lost classification. When the registry is unavailable, report that validation could not be performed rather than claiming the label does not exist. Local metadata labels are free-form and should reuse the local vocabulary.

Prefer native fields over labels and textual prefixes. Do not reintroduce a type prefix when the repository uses native Issue Types unless its declared title convention requires it. Defaults apply only to undeclared choices; obtain the fallback taxonomy from the bundled conventions helper where supplied.
