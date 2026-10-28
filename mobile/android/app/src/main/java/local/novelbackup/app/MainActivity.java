package local.novelbackup.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 自作プラグインは super.onCreate より前に登録する
        registerPlugin(SiteViewPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
