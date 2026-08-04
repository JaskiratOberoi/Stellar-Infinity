# Order detail check

Folded into `VerifyPaging` rather than given its own tool: it needs the same
minted token and the same base URL, and a second copy of that setup would be a
second thing to keep in step.

The check is deliberately end-to-end. The bug it guards against —
three overlapping readers on a connection with MARS disabled — compiles
cleanly, passes any unit test that stubs the database, and throws on every
real request. Only an actual round trip to SQL Server catches it.
