-- HTTP package invocation token code and rows were removed in 0084 (after that
-- worker was live). Drop the empty leftover table; indexes go with it.
DROP TABLE IF EXISTS package_invocation_tokens;
