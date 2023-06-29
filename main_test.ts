import { assertEquals } from "https://deno.land/std@0.192.0/testing/asserts.ts";
import { serve } from "./main.ts";

Deno.test(function serveTest() {
  assertEquals(typeof serve, "function");
});
