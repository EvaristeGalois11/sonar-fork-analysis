import java.io.File;
import java.io.FileInputStream;
import java.io.InputStreamReader;
import java.io.Reader;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Properties;

// Reads settings files the way sonar-scanner-cli 8.1 reads project.settings (Conf.toProperties):
// Properties.load through a UTF-8 reader, then every value trimmed. Prints one line per setting as
// UTF-16 code units in hex, so nothing is lost on the way back. Takes the directory holding the files.
public class ReadSettings {
    public static void main(String[] args) throws Exception {
        File[] files = new File(args[0]).listFiles();
        Arrays.sort(files);
        for (File file : files) {
            Properties properties = new Properties();
            try (Reader reader = new InputStreamReader(new FileInputStream(file), StandardCharsets.UTF_8)) {
                properties.load(reader);
            }
            System.out.println("file " + file.getName());
            for (String key : properties.stringPropertyNames()) {
                System.out.println(hex(key) + " " + hex(properties.getProperty(key).trim()));
            }
        }
    }

    private static String hex(String text) {
        StringBuilder builder = new StringBuilder("x");
        for (char c : text.toCharArray()) builder.append(String.format("%04x", (int) c));
        return builder.toString();
    }
}
