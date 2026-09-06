# Execution completion signal

After fresh verification, emit `<promise>COMPLETE</promise>` only when all required stories pass and unresolved review findings have been addressed. In a pipeline this means execution is complete, not that review or publication succeeded. On blockers return their evidence and preserve state; never emit the completion signal.
