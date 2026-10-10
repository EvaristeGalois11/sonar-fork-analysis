package probe;

import java.io.File;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.TreeSet;
import java.util.jar.JarEntry;
import java.util.jar.JarFile;

// Asks the real scanner how it reads what the analysis writes, by calling its own code. Strings travel
// as UTF-16 code units in hex, prefixed with x, so nothing is lost on the way; every output line starts
// with a word saying what it is, since the scanner's logging may print too.
//   cli <dir>          each file, read the way the CLI reads project.settings
//   csv <file>         each line, split the way the engine splits list settings
//   modules <file>     each case, walked into modules the way the engine builds the project, with the
//                      keys each module gets
//   matches <file>     each line (pattern, absolute path, relative path): how many patterns the engine
//                      makes of it, and whether one matches the file the way languages are detected
//   processes <jar>    the engine classes that can start a process
//   resolve <file>     each line, as a setting's value once the CLI resolves its placeholders, next to
//                      a setting other=OTHER and an environment holding NAME=ENV
public class ScannerProbe {
    public static void main(String[] args) throws Exception {
        switch (args[0]) {
            case "cli" -> cli(new File(args[1]));
            case "csv" -> csv(Path.of(args[1]));
            case "matches" -> matches(Path.of(args[1]));
            case "modules" -> modules(Path.of(args[1]));
            case "processes" -> processes(new File(args[1]));
            case "resolve" -> resolve(Path.of(args[1]));
            default -> throw new IllegalArgumentException(args[0]);
        }
    }

    private static void cli(File directory) throws Exception {
        Method read = Class.forName("org.sonarsource.scanner.cli.Conf").getDeclaredMethod("toProperties", Path.class);
        read.setAccessible(true);
        File[] files = directory.listFiles();
        Arrays.sort(files);
        for (File file : files) {
            Properties properties = (Properties) read.invoke(null, file.toPath());
            System.out.println("file " + file.getName());
            for (String key : properties.stringPropertyNames()) {
                System.out.println("entry " + hex(key) + " " + hex(properties.getProperty(key)));
            }
        }
    }

    private static void matches(Path input) throws Exception {
        Class<?> pathPattern = Class.forName("org.sonar.scanner.plugin.api.impl.fs.PathPattern");
        Method create = pathPattern.getMethod("create", String[].class);
        Method match = pathPattern.getMethod("match", Path.class, Path.class, boolean.class);
        for (String line : Files.readAllLines(input, StandardCharsets.UTF_8)) {
            String[] parts = line.split(" ");
            Object[] patterns = (Object[]) create.invoke(null, (Object) new String[] {unhex(parts[0])});
            boolean matched = false;
            for (Object pattern : patterns) {
                // Language detection ignores case.
                matched |= (Boolean) match.invoke(pattern, Path.of(unhex(parts[1])), Path.of(unhex(parts[2])), false);
            }
            System.out.println("matched " + patterns.length + " " + matched);
        }
    }

    private static void resolve(Path input) throws Exception {
        Class<?> resolver = Class.forName("org.sonarsource.scanner.cli.PropertyResolver");
        var create = resolver.getConstructor(Properties.class, Map.class);
        Method run = resolver.getMethod("resolve");
        for (String line : Files.readAllLines(input, StandardCharsets.UTF_8)) {
            Properties settings = new Properties();
            settings.setProperty("value", unhex(line));
            settings.setProperty("other", "OTHER");
            try {
                Properties resolved = (Properties) run.invoke(create.newInstance(settings, Map.of("NAME", "ENV")));
                System.out.println("resolved " + hex(resolved.getProperty("value")));
            } catch (InvocationTargetException failed) {
                System.out.println("refused " + hex(String.valueOf(failed.getCause().getMessage())));
            }
        }
    }

    private static void csv(Path input) throws Exception {
        Method split = Class.forName("org.sonar.scanner.plugin.api.impl.config.MultivalueProperty")
                .getMethod("parseAsCsv", String.class, String.class);
        for (String line : Files.readAllLines(input, StandardCharsets.UTF_8)) {
            String[] entries = (String[]) split.invoke(null, "key", unhex(line));
            List<String> out = new ArrayList<>();
            for (String entry : entries) out.add(hex(entry));
            System.out.println("split " + String.join(" ", out));
        }
    }

    private static void modules(Path input) throws Exception {
        Method walk = builder().getDeclaredMethod("extractPropertiesByModule", Map.class, String.class, String.class, Map.class);
        walk.setAccessible(true);
        List<Map<String, String>> cases = new ArrayList<>();
        for (String line : Files.readAllLines(input, StandardCharsets.UTF_8)) {
            if (line.equals("case")) cases.add(new HashMap<>());
            else {
                String[] pair = line.split(" ");
                cases.get(cases.size() - 1).put(unhex(pair[0]), unhex(pair[1]));
            }
        }
        for (Map<String, String> settings : cases) {
            System.out.println("case");
            Map<String, Map<String, String>> byModule = new HashMap<>();
            try {
                walk.invoke(null, byModule, "", "", new HashMap<>(settings));
            } catch (InvocationTargetException failed) {
                // Only the engine's own refusal of a project; anything else is a failure of the check.
                // By name, like every Sonar class here: the same file also runs with only the scanner CLI's
                // jar on the class path, which doesn't have this class, and Java compiles it either way.
                if (!failed.getCause().getClass().getName().equals("org.sonar.api.utils.MessageException")) throw failed; // NOSONAR
                System.out.println("refused " + hex(String.valueOf(failed.getCause().getMessage())));
                continue;
            }
            for (Map.Entry<String, Map<String, String>> module : byModule.entrySet()) {
                System.out.println("module " + hex(module.getKey()));
                for (String key : module.getValue().keySet()) System.out.println("key " + hex(key));
            }
        }
    }

    // The class moved between engines: SonarQube's 13.7 has the older one, SonarCloud's 13.14 the newer.
    private static Class<?> builder() throws ClassNotFoundException {
        try {
            return Class.forName("org.sonar.scanner.scan.ProjectStructureBuilder");
        } catch (ClassNotFoundException older) {
            return Class.forName("org.sonar.scanner.scan.ProjectReactorBuilder");
        }
    }

    // What starts a process, directly or through the helpers the engine bundles; a class using any of
    // them is listed.
    private static final byte[][] STARTERS = {
        utf8("java/lang/ProcessBuilder"),
        utf8("java.lang.ProcessBuilder"),
        // Runtime.exec: the method name as a constant pool entry (tag 1, length 4).
        {1, 0, 4, 'e', 'x', 'e', 'c'},
        utf8("org/sonar/scanner/process/executor/ProcessWrapperFactory"),
        utf8("org/sonar/api/utils/command/CommandExecutor"),
        utf8("org/apache/commons/exec/DefaultExecutor"),
        utf8("org/apache/commons/exec/CommandLine"),
        utf8("com/sonar/sca/scanner/internal/DefaultProcessExecutor")
    };

    private static void processes(File jar) throws Exception {
        TreeSet<String> found = new TreeSet<>();
        try (JarFile file = new JarFile(jar)) {
            for (JarEntry entry : Collections.list(file.entries())) {
                if (!entry.getName().endsWith(".class")) continue;
                byte[] bytes = file.getInputStream(entry).readAllBytes();
                for (byte[] starter : STARTERS) {
                    if (contains(bytes, starter)) {
                        found.add(entry.getName().replaceAll("(\\$.*)?\\.class$", ""));
                        break;
                    }
                }
            }
        }
        found.forEach(name -> System.out.println("class " + name));
    }

    private static byte[] utf8(String text) {
        return text.getBytes(StandardCharsets.UTF_8);
    }

    private static boolean contains(byte[] bytes, byte[] part) {
        outer:
        for (int i = 0; i <= bytes.length - part.length; i++) {
            for (int j = 0; j < part.length; j++) if (bytes[i + j] != part[j]) continue outer;
            return true;
        }
        return false;
    }

    private static String hex(String text) {
        StringBuilder builder = new StringBuilder("x");
        for (char c : text.toCharArray()) builder.append(String.format("%04x", (int) c));
        return builder.toString();
    }

    private static String unhex(String text) {
        StringBuilder builder = new StringBuilder();
        for (int i = 1; i < text.length(); i += 4) builder.append((char) Integer.parseInt(text.substring(i, i + 4), 16));
        return builder.toString();
    }
}
