import { redirect } from 'next/navigation';

export default function Home() {
  // There is one screen that matters. Land on it.
  redirect('/today');
}
