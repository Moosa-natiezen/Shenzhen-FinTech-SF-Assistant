CREATE TABLE "credit_profiles" (
	"student_user_id" text PRIMARY KEY NOT NULL,
	"national_id_spii" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "r_score_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"student_user_id" text NOT NULL,
	"score" integer NOT NULL,
	"t_tuition" numeric(6, 5) NOT NULL,
	"b_bills" numeric(6, 5) NOT NULL,
	"s_wallet" numeric(6, 5) NOT NULL,
	"l_repay" numeric(6, 5) NOT NULL,
	"trigger_event" text NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sponsor_links" (
	"id" text PRIMARY KEY NOT NULL,
	"sponsor_user_id" text NOT NULL,
	"student_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sponsor_links_sponsor_student_uq" UNIQUE("sponsor_user_id","student_user_id")
);
--> statement-breakpoint
CREATE TABLE "tuition_payments" (
	"id" text PRIMARY KEY NOT NULL,
	"transaction_id" text NOT NULL,
	"student_user_id" text NOT NULL,
	"university_id" text NOT NULL,
	"wallet_id" text NOT NULL,
	"currency" text NOT NULL,
	"amount" numeric(20, 8) NOT NULL,
	"status" text DEFAULT 'settled' NOT NULL,
	"receipt_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "universities" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"country" text NOT NULL,
	"currency" text NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"bank_details_spii" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "credit_profiles" ADD CONSTRAINT "credit_profiles_student_user_id_user_id_fk" FOREIGN KEY ("student_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "r_score_snapshots" ADD CONSTRAINT "r_score_snapshots_student_user_id_user_id_fk" FOREIGN KEY ("student_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sponsor_links" ADD CONSTRAINT "sponsor_links_sponsor_user_id_user_id_fk" FOREIGN KEY ("sponsor_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sponsor_links" ADD CONSTRAINT "sponsor_links_student_user_id_user_id_fk" FOREIGN KEY ("student_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tuition_payments" ADD CONSTRAINT "tuition_payments_student_user_id_user_id_fk" FOREIGN KEY ("student_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tuition_payments" ADD CONSTRAINT "tuition_payments_university_id_universities_id_fk" FOREIGN KEY ("university_id") REFERENCES "public"."universities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tuition_payments" ADD CONSTRAINT "tuition_payments_wallet_id_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE restrict ON UPDATE no action;