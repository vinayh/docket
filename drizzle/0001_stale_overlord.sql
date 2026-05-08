PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_canonical_comment` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`origin_version_id` text NOT NULL,
	`origin_user_id` text,
	`origin_user_email` text,
	`origin_user_display_name` text,
	`origin_timestamp` integer NOT NULL,
	`anchor` text NOT NULL,
	`body` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`parent_comment_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`origin_version_id`) REFERENCES `version`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`origin_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`parent_comment_id`) REFERENCES `canonical_comment`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_canonical_comment`("id", "project_id", "origin_version_id", "origin_user_id", "origin_user_email", "origin_user_display_name", "origin_timestamp", "anchor", "body", "status", "parent_comment_id", "created_at") SELECT "id", "project_id", "origin_version_id", "origin_user_id", "origin_user_email", "origin_user_display_name", "origin_timestamp", "anchor", "body", "status", "parent_comment_id", "created_at" FROM `canonical_comment`;--> statement-breakpoint
DROP TABLE `canonical_comment`;--> statement-breakpoint
ALTER TABLE `__new_canonical_comment` RENAME TO `canonical_comment`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `canonical_comment_project_idx` ON `canonical_comment` (`project_id`);--> statement-breakpoint
CREATE INDEX `comment_projection_version_google_idx` ON `comment_projection` (`version_id`,`google_comment_id`);