CREATE TABLE `drive_watch_channel` (
	`id` text PRIMARY KEY NOT NULL,
	`version_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`resource_id` text NOT NULL,
	`token` text,
	`address` text NOT NULL,
	`expiration` integer,
	`created_at` integer NOT NULL,
	`last_event_at` integer,
	`last_synced_at` integer,
	FOREIGN KEY (`version_id`) REFERENCES `version`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `drive_watch_channel_channel_id_unique` ON `drive_watch_channel` (`channel_id`);--> statement-breakpoint
CREATE INDEX `drive_watch_version_idx` ON `drive_watch_channel` (`version_id`);