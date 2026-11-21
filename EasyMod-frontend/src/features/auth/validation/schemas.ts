import { z } from "zod";

export interface SigninValidationMessages {
  emailRequired: string;
  emailInvalid: string;
  passwordRequired: string;
}

export interface SignupValidationMessages extends SigninValidationMessages {
  nameMin: string;
  nameMax: string;
  phoneRequired: string;
  phoneInvalid: string;
  passwordMin: string;
  passwordUppercase: string;
  passwordLowercase: string;
  passwordDigit: string;
  passwordSpecial: string;
  termsRequired: string;
}

const DEFAULT_SIGNIN_MESSAGES: SigninValidationMessages = {
  emailRequired: "Email is required",
  emailInvalid: "Please enter a valid email address",
  passwordRequired: "Password is required",
};

const DEFAULT_SIGNUP_MESSAGES: SignupValidationMessages = {
  ...DEFAULT_SIGNIN_MESSAGES,
  nameMin: "Name must be at least 2 characters",
  nameMax: "Name must be less than 100 characters",
  phoneRequired: "Mobile number is required",
  phoneInvalid: "Enter a valid 11-digit mobile number (01XXXXXXXXX)",
  passwordMin: "Password must be at least 8 characters",
  passwordUppercase: "Password must contain at least one uppercase letter",
  passwordLowercase: "Password must contain at least one lowercase letter",
  passwordDigit: "Password must contain at least one number",
  passwordSpecial: "Password must contain at least one special character",
  termsRequired: "You must accept the terms and conditions",
};

export function createSigninSchema(messages: SigninValidationMessages = DEFAULT_SIGNIN_MESSAGES) {
  return z.object({
    email: z
      .string()
      .min(1, messages.emailRequired)
      .email(messages.emailInvalid),
    password: z.string().min(1, messages.passwordRequired),
  });
}

export const signinSchema = createSigninSchema();

export type SigninFormData = z.infer<typeof signinSchema>;
export type SigninFormInput = z.input<typeof signinSchema>;

export function createSignupSchema(messages: SignupValidationMessages = DEFAULT_SIGNUP_MESSAGES) {
  return z.object({
    fullName: z
      .string()
      .min(2, messages.nameMin)
      .max(100, messages.nameMax),
    email: z
      .string()
      .min(1, messages.emailRequired)
      .email(messages.emailInvalid),
    phone: z
      .string()
      .min(1, messages.phoneRequired)
      .regex(/^01[3-9]\d{8}$/, messages.phoneInvalid),
    // Must stay in lockstep with PASSWORD_RULES in ./passwordPolicy — the API
    // rejects passwords without a special character, so the client must too.
    password: z
      .string()
      .min(8, messages.passwordMin)
      .regex(/[A-Z]/, messages.passwordUppercase)
      .regex(/[a-z]/, messages.passwordLowercase)
      .regex(/[0-9]/, messages.passwordDigit)
      .regex(/[^A-Za-z0-9]/, messages.passwordSpecial),
    acceptedTerms: z.boolean().refine((value) => value === true, {
      message: messages.termsRequired,
    }),
  }).strict();
}

export const signupSchema = createSignupSchema();

export type SignupFormData = z.infer<typeof signupSchema>;
