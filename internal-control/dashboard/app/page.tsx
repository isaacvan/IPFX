import { redirect } from "next/navigation";

// Root just forwards into the owner area — requireOwner() in the
// (owner) layout is what actually gates access; this redirect is
// purely a navigation convenience, never a security boundary.
export default function Home() {
  redirect("/review-queue");
}
