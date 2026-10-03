-- Site banners are retired. Drop dismissals first (FK to site_banners), then
-- the banners table (indexes go with each table).
DROP TABLE IF EXISTS site_banner_dismissals;
DROP TABLE IF EXISTS site_banners;
