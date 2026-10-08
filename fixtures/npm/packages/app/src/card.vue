<!-- Deliberate issues for Sonar to find in a Vue component. -->
<template>
  <img src="card.png" />
</template>

<script setup lang="ts">
// Top-level names are visible to the template. So the dead store goes in a function.
function width(columns: number): number {
  const unused = columns * 2;
  return columns * 10;
}
</script>

<style>
.card {
}
</style>
