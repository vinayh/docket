ALTER TABLE `version` ADD `last_synced_at` integer;--> statement-breakpoint
ALTER TABLE `drive_watch_channel` DROP COLUMN `last_synced_at`;