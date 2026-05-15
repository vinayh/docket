PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_review_action_token` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`review_request_id` text NOT NULL,
	`assignee_user_id` text NOT NULL,
	`action` text NOT NULL,
	`issued_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	FOREIGN KEY (`review_request_id`) REFERENCES `review_request`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`assignee_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_review_action_token`("id", "token_hash", "review_request_id", "assignee_user_id", "action", "issued_at", "expires_at", "used_at") SELECT "id", "token_hash", "review_request_id", "assignee_user_id", "action", "issued_at", "expires_at", "used_at" FROM `review_action_token`;--> statement-breakpoint
DROP TABLE `review_action_token`;--> statement-breakpoint
ALTER TABLE `__new_review_action_token` RENAME TO `review_action_token`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `review_action_token_token_hash_unique` ON `review_action_token` (`token_hash`);--> statement-breakpoint
CREATE INDEX `review_action_token_assignment_idx` ON `review_action_token` (`review_request_id`,`assignee_user_id`);