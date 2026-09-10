-- Signup is open. Operator-minted invite codes are no longer a product
-- surface, so drop the leftover table (indexes and the created_by FK go
-- with it). Historical rows are deleted with the table.
DROP TABLE IF EXISTS invites;
