# Fake AI answers (demo)

The demo "AI" serves one of these files. `correct.js` is the only right answer; every other file is
subtly wrong (typo, missing return, wrong name, returns nothing, syntax error). The server flips a secure
50/50 coin: correct vs. one random wrong file. The verdict never leaves the server until the judge runs.
