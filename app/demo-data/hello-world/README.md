# Fake AI answers (demo)

The demo "AI" serves one of these C files. `correct.c` is the only right answer. Every other file has one
silly mistake (missing `;`, `return exit;`, `print` instead of `printf`, `return "0";`) and, to tell them apart
at a glance, prints `"Hello world!"` WITHOUT the trailing `\n`. The server flips a secure 50/50 coin: correct
vs. one random wrong file. The verdict never leaves the server until the judge runs.
