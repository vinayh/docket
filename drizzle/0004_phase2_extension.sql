CREATE TABLE `api_token` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`token_preview` text NOT NULL,
	`label` text,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_token_token_hash_unique` ON `api_token` (`token_hash`);--> statement-breakpoint
CREATE INDEX `api_token_user_idx` ON `api_token` (`user_id`);--> statement-breakpoint
ALTER TABLE `canonical_comment` ADD `kix_discussion_id` text;--> statement-breakpoint
ALTER TABLE `canonical_comment` ADD `external_id` text;--> statement-breakpoint
CREATE INDEX `canonical_comment_kix_idx` ON `canonical_comment` (`origin_version_id`,`kix_discussion_id`);--> statement-breakpoint
CREATE INDEX `canonical_comment_capture_idx` ON `canonical_comment` (`origin_version_id`,`external_id`);