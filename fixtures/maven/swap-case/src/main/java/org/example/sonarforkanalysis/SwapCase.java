package org.example.sonarforkanalysis;

public class SwapCase {
  public String swapCase(String str) {
    return str.codePoints()
        .map(this::swapCase)
        .collect(StringBuilder::new, StringBuilder::appendCodePoint, StringBuilder::append)
        .toString();
  }

  private int swapCase(int c) {
    return Character.isLowerCase(c) ? Character.toUpperCase(c) : Character.toLowerCase(c);
  }
}
